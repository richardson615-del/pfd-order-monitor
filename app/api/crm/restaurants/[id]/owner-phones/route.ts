import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { parseOwnerPhones } from "@/lib/partner-app";

export const dynamic = "force-dynamic";

/**
 * The owners' cells that may sign in to PFD Partner with a texted code (PA1).
 *
 *   GET -> { phones: [{ phone, name, created_at }] }
 *   PUT { phones: [{ phone, name? }], actor? } -> the list, replaced whole.
 *
 * CRM_WRITE_KEY, like every /api/crm route. Phones are E.164 US numbers.
 */
async function restaurantFor(ref: string) {
  return findRestaurantByRef<{ id: string }>(ref, "id");
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const r = await restaurantFor(params.id);
  if (!r) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  const { data, error } = await supabaseAdmin().from("app_owner_phones").select("phone, name, created_at").eq("restaurant_id", r.id).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ phones: data ?? [] });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const r = await restaurantFor(params.id);
  if (!r) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) ?? {};
  const parsed = parseOwnerPhones(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const actor = typeof body.actor === "string" ? body.actor.slice(0, 120) : null;
  const admin = supabaseAdmin();
  const keep = parsed.phones.map((p) => p.phone);
  const del = admin.from("app_owner_phones").delete().eq("restaurant_id", r.id);
  const { error: delErr } = keep.length ? await del.not("phone", "in", `(${keep.map((p) => `"${p}"`).join(",")})`) : await del;
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  if (parsed.phones.length) {
    const { error } = await admin
      .from("app_owner_phones")
      .upsert(parsed.phones.map((p) => ({ restaurant_id: r.id, phone: p.phone, name: p.name, added_by: actor })), { onConflict: "restaurant_id,phone" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const { data } = await admin.from("app_owner_phones").select("phone, name, created_at").eq("restaurant_id", r.id).order("created_at");
  return NextResponse.json({ phones: data ?? [] });
}
