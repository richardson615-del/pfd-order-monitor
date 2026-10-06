import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getCurrentUserRestaurantIds } from "@/lib/authz";
import { buildScoreboard, scoreboardWindowStart, type ScoreOrder } from "@/lib/scoreboard";

export const dynamic = "force-dynamic";

/** Rows per read. The platform caps a single read near 1,000 regardless of the range asked for (see app/api/crm/accounting/orders). */
const PAGE = 1000;
/** A month of a very busy restaurant. Past this the stats are computed on what was read and say so. */
const MAX_ROWS = 12_000;

/**
 * GET /api/dashboard/scoreboard
 *
 * The Stats tab (lib/scoreboard.ts). Read-only, the restaurant from the
 * session, RLS applies - the same shape as /api/dashboard/history. Only the
 * five columns the scoring needs are read, paged, so a busy month is not
 * silently cut at the platform's row cap.
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
  const { data: restaurant } = await supabase.from("restaurants").select("timezone").eq("id", restaurantId).maybeSingle();

  const rows: ScoreOrder[] = [];
  let truncated = false;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("orders")
      .select("received_at, accepted_at, status, source, customer_total")
      .eq("restaurant_id", restaurantId)
      .gte("received_at", scoreboardWindowStart(now))
      .order("received_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows.push(...((data ?? []) as ScoreOrder[]));
    if (!data || data.length < PAGE) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
  }

  const timezone = restaurant?.timezone ?? null;
  return NextResponse.json(
    { timezone, truncated, scoreboard: buildScoreboard(rows, now, timezone) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
