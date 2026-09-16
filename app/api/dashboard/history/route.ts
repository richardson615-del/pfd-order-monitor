import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { HISTORY_DAYS, HISTORY_DAY_CAP, historyWindowStart, weekHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/history
 *
 * The Past week tab: seven day tiles (count + $) and each day's orders,
 * newest first, in the restaurant's own timezone. Read-only. The
 * restaurant comes from the session, the way the heartbeat does it.
 *
 * Fetched through the session client, so RLS applies - this is the
 * restaurant reading its own orders. The window is generous (a day either
 * side); lib/history.ts keeps only the seven local days.
 */
export async function GET() {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [restaurantId] = await getCurrentUserRestaurantIds();
  if (!restaurantId) return NextResponse.json({ error: "no restaurant" }, { status: 400 });

  const now = Date.now();
  const [{ data: restaurant }, { data: orders, error }] = await Promise.all([
    supabase.from("restaurants").select("timezone").eq("id", restaurantId).maybeSingle(),
    supabase
      .from("orders")
      .select("id, order_number, order_type, customer_name, customer_total, status, source, received_at, completed_at, cancelled_at")
      .eq("restaurant_id", restaurantId)
      .gte("received_at", historyWindowStart(now))
      .order("received_at", { ascending: false })
      // Seven days at the cap, plus the slack days. Past this the day is
      // marked truncated rather than the query silently dropping the oldest.
      .limit((HISTORY_DAYS + 2) * HISTORY_DAY_CAP),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const timezone = restaurant?.timezone ?? null;
  return NextResponse.json(
    { timezone, days: weekHistory(orders ?? [], now, timezone) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
