import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { DEFAULT_THRESHOLDS } from "@/lib/health";
import { resolveOrCreateRestaurant } from "@/lib/restaurant-resolve";

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
  const name = String(body?.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // The CRM knows about restaurants this database has never heard of, so an
  // unknown id is a gap to close rather than a request to reject.
  const resolved = await resolveOrCreateRestaurant({
    restaurantId: body?.restaurant_id,
    crmRestaurantId: body?.crm_restaurant_id,
    restaurantName: body?.restaurant_name ?? body?.restaurant?.name,
  });
  if (!resolved.restaurant) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const restaurant = resolved.restaurant;

  const admin = supabaseAdmin();

  const deviceKey = generateDeviceKey();
  const { data, error } = await admin
    .from("print_devices")
    .insert({ restaurant_id: restaurant.id, name, device_key: deviceKey })
    .select("id, name, is_active, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    device: { ...data, restaurant: { id: restaurant.id, name: restaurant.name } },
    // So the console can say "created Torino's" rather than silently
    // inventing a restaurant nobody asked for.
    restaurant_created: resolved.created,
    device_key: deviceKey,
    note: "Shown once. Type it into the printer's WebConfig ID field - it cannot be retrieved again.",
  });
}
