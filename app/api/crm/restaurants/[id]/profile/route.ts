import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { parseProfilePush } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PUT /api/crm/restaurants/:id/profile { hours, hours_lines, ordering_channel? }
 *
 * The CRM pushes the restaurant's hours for the Store tab (migration 052),
 * after its own hours change (including one the kitchen sent). One row per
 * restaurant, replaced whole. The pause is NOT here: the tablet owns it.
 * GET returns what is held.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const parsed = parseProfilePush(await req.json().catch(() => null));
  if (parsed.kind === "error") return NextResponse.json({ error: parsed.error, code: "invalid" }, { status: 400 });
  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null }>(params.id, "id, crm_restaurant_id");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
  const pushedAt = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from("restaurant_profiles")
    .upsert({ restaurant_id: restaurant.id, hours: parsed.hours, hours_lines: parsed.hours_lines, ordering_channel: parsed.ordering_channel, pushed_at: pushedAt }, { onConflict: "restaurant_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ restaurant_id: restaurant.id, crm_restaurant_id: restaurant.crm_restaurant_id, pushed_at: pushedAt });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  const restaurant = await findRestaurantByRef<{ id: string; crm_restaurant_id: string | null; online_paused_until: string | null }>(params.id, "id, crm_restaurant_id, online_paused_until");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
  const { data } = await supabaseAdmin().from("restaurant_profiles").select("hours_lines, ordering_channel, pushed_at").eq("restaurant_id", restaurant.id).maybeSingle();
  return NextResponse.json({ restaurant_id: restaurant.id, crm_restaurant_id: restaurant.crm_restaurant_id, online_paused_until: restaurant.online_paused_until, profile: data ?? null }, { headers: { "Cache-Control": "no-store" } });
}
