import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { UUID_RE, findRestaurantByRef } from "@/lib/restaurant-ref";
import { RESTAURANT_SELECT, loadRosterContext, shapeRestaurantRow } from "@/lib/crm-roster";
import { relinkRestaurant, type RelinkStore } from "@/lib/relink";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id/relink  { crm_restaurant_id, actor? }
 *
 * Moves this restaurant's link to another CRM account, so the CRM can merge
 * a duplicate account into its survivor (R1, Nick 2026-09-24). Changes only
 * `restaurants.crm_restaurant_id`; the rules are in lib/relink.ts.
 *
 * Nothing is cached by the CRM account id - every side table (printers,
 * tablets, heartbeats, logins, orders) is keyed by `restaurants.id`, and
 * every CRM route resolves the account id fresh from this row - so the next
 * call by the new id resolves immediately and the old id is a 404.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const admin = supabaseAdmin();
  const LINK = "id, name, crm_restaurant_id";

  const store: RelinkStore = {
    findByRef: (ref) => findRestaurantByRef(ref, LINK),
    async findOtherHolder(value, exceptId) {
      const filter = UUID_RE.test(value) ? `id.eq.${value},crm_restaurant_id.eq.${value}` : `crm_restaurant_id.eq.${value}`;
      const { data } = await admin.from("restaurants").select(LINK).or(filter).neq("id", exceptId).limit(1).maybeSingle();
      return (data as any) ?? null;
    },
    async setCrmRestaurantId(id, value) {
      const { error } = await admin.from("restaurants").update({ crm_restaurant_id: value }).eq("id", id);
      if (!error) return "ok";
      // 23505 = restaurants_crm_restaurant_id_key (migration 007).
      if (error.code === "23505") return "taken";
      throw new Error(error.message);
    },
    async writeAudit(row) {
      const { error } = await admin.from("restaurant_link_audit").insert(row);
      return error ? error.message : null;
    },
  };

  let outcome;
  try {
    outcome = await relinkRestaurant(store, params.id, body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "relink failed" }, { status: 500 });
  }
  if (outcome.status !== 200) {
    return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  }

  const { data: row } = await admin.from("restaurants").select(RESTAURANT_SELECT).eq("id", outcome.restaurant.id).maybeSingle();
  const ctx = await loadRosterContext([outcome.restaurant.id]);
  return NextResponse.json({
    ok: true,
    changed: outcome.changed,
    previous_crm_restaurant_id: outcome.previous_crm_restaurant_id,
    crm_restaurant_id: outcome.restaurant.crm_restaurant_id,
    ...(outcome.warning ? { warning: outcome.warning } : {}),
    restaurant: row ? shapeRestaurantRow(row, ctx) : outcome.restaurant,
  });
}
