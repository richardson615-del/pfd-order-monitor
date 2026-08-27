import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_THRESHOLDS } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * CRM device management bridge.
 *
 *   GET  /api/crm/devices   - every printer, with the restaurant it serves
 *   POST /api/crm/devices   - register one, returning its key exactly once
 *
 * Authenticated with CRM_WRITE_KEY (see lib/crm-auth.ts), which is deliberately
 * NOT the read key.
 */

/** Human-typeable key: PFD-XXXX-XXXX-XXXX, no ambiguous characters. */
function generateDeviceKey(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from(randomBytes(4))
      .map((b) => alphabet[b % alphabet.length])
      .join("");
  return `PFD-${chunk()}-${chunk()}-${chunk()}`;
}

export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("print_devices")
    .select("id, name, is_active, last_seen_at, printer_name, app_version, created_at, restaurants(id, name)")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = Date.now();
  const silentMs = DEFAULT_THRESHOLDS.deviceSilentMinutes * 60_000;

  return NextResponse.json({
    devices: (data ?? []).map((d: any) => {
      const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null;
      return {
        id: d.id,
        name: d.name,
        // What the hardware reports about itself, e.g. "TM-m30III".
        model: d.printer_name ?? null,
        transport: d.app_version ?? null,
        is_active: d.is_active,
        last_seen_at: d.last_seen_at,
        // Precomputed so every CRM view agrees with the alerting thresholds
        // rather than each screen inventing its own idea of "online".
        online: seen !== null && now - seen < silentMs,
        created_at: d.created_at,
        restaurant: d.restaurants
          ? { id: d.restaurants.id, name: d.restaurants.name }
          : null,
      };
    }),
  });
}

/**
 * POST /api/crm/devices  { restaurant_id, name }
 *
 * device_key is returned ONCE, in this response, and by no other endpoint -
 * matching the write-once design of the admin panel. It is what gets typed
 * into the printer's WebConfig, so losing it means registering a new device.
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const restaurantId = String(body?.restaurant_id ?? "").trim();
  const name = String(body?.name ?? "").trim();
  if (!restaurantId || !name) {
    return NextResponse.json(
      { error: "restaurant_id and name are required" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();
  // Verify the restaurant first: an unknown id would otherwise surface as an
  // opaque foreign-key error the CRM cannot show anyone useful.
  const { data: restaurant } = await admin
    .from("restaurants")
    .select("id, name")
    .eq("id", restaurantId)
    .maybeSingle();
  if (!restaurant) {
    return NextResponse.json({ error: "restaurant not found" }, { status: 400 });
  }

  const deviceKey = generateDeviceKey();
  const { data, error } = await admin
    .from("print_devices")
    .insert({ restaurant_id: restaurantId, name, device_key: deviceKey })
    .select("id, name, is_active, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    device: { ...data, restaurant: { id: restaurant.id, name: restaurant.name } },
    device_key: deviceKey,
    note: "Shown once. Type it into the printer's WebConfig ID field - it cannot be retrieved again.",
  });
}
