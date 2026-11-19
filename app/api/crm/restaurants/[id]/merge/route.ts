import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { RESTAURANT_SELECT, loadRosterContext, shapeRestaurantRow } from "@/lib/crm-roster";
import { mergeErrorFor, parseMergeBody } from "@/lib/merge-restaurants";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/restaurants/:id/merge  { into, take_crm?, actor? }
 *
 * Moves the duplicate `:id` onto `into` (either id for both) and switches the
 * duplicate off: Zuppler listings, the CRM link when take_crm (or when `into`
 * has none), orders (renumbered after `into`'s last ticket), printers,
 * tablets, logins and the rest. One transaction (merge_restaurants, migration
 * 064). Answers the kept restaurant as a roster row plus what moved.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const parsed = parseMergeBody(await req.json().catch(() => null));
  if (parsed.ok === false) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });

  const [from, into] = await Promise.all([
    findRestaurantByRef<{ id: string }>(params.id, "id"),
    findRestaurantByRef<{ id: string }>(parsed.input.into, "id"),
  ]);
  if (!from || !into) return NextResponse.json({ error: "One of the two restaurants doesn't exist.", code: "restaurant_not_found" }, { status: 404 });

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("merge_restaurants", {
    p_from: from.id,
    p_into: into.id,
    p_take_crm: parsed.input.take_crm,
    p_actor: parsed.input.actor,
  });
  if (error) {
    const e = mergeErrorFor(error.message);
    return NextResponse.json({ error: e.error, code: e.code }, { status: e.status });
  }

  const { data: row } = await admin.from("restaurants").select(RESTAURANT_SELECT).eq("id", into.id).maybeSingle();
  const ctx = await loadRosterContext([into.id]);
  return NextResponse.json({ ok: true, merged_from: from.id, moved: data, restaurant: row ? shapeRestaurantRow(row, ctx) : { id: into.id } });
}
