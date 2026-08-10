import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isCurrentUserAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** GET /api/admin/print-devices?restaurant_id=... - list devices */
export async function GET(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const restaurantId = req.nextUrl.searchParams.get("restaurant_id");
  const admin = supabaseAdmin();
  let q = admin
    .from("print_devices")
    .select("id, restaurant_id, name, is_active, last_seen_at, printer_name, app_version, created_at")
    .order("created_at", { ascending: false });
  if (restaurantId) q = q.eq("restaurant_id", restaurantId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ devices: data });
}

/**
 * POST /api/admin/print-devices - register a new device
 * Body: { restaurant_id, name }
 * Returns the device_key ONCE - it is shown to be typed into the tablet
 * and is not retrievable again (rotate by creating a new device).
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const restaurantId = body?.restaurant_id;
  const name = (body?.name || "").trim();
  if (!restaurantId || !name) {
    return NextResponse.json(
      { error: "restaurant_id and name are required" },
      { status: 400 }
    );
  }

  // Human-typeable key: PFD-XXXX-XXXX-XXXX (no ambiguous chars)
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from(randomBytes(4))
      .map((b) => alphabet[b % alphabet.length])
      .join("");
  const deviceKey = `PFD-${chunk()}-${chunk()}-${chunk()}`;

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("print_devices")
    .insert({ restaurant_id: restaurantId, name, device_key: deviceKey })
    .select("id, restaurant_id, name, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ device: data, device_key: deviceKey });
}

/** PATCH /api/admin/print-devices - activate/deactivate/rename
 * Body: { id, is_active?, name? } */
export async function PATCH(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const updates: Record<string, unknown> = {};
  if (typeof body.is_active === "boolean") updates.is_active = body.is_active;
  if (typeof body.name === "string" && body.name.trim())
    updates.name = body.name.trim();

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("print_devices")
    .update(updates)
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
