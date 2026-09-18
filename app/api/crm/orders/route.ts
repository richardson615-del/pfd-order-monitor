import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { ORDER_LIST_SELECT, loadOrderContext } from "@/lib/crm-orders-data";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import {
  DEFAULT_ORDERS_TZ,
  ORDERS_LIST_LIMIT,
  changedSince,
  localDayWindow,
  orderCounts,
  shapeOrderRow,
  sortOrderRows,
  type OrderListRow,
  type OrderRowInput,
} from "@/lib/crm-orders";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/crm/orders?date=YYYY-MM-DD[&tz=][&restaurant_id=][&include_test=1][&since=<ISO>]
 *
 * One local day of orders, across every restaurant or one, in the order
 * the tablet shows them, with what each ticket said, where it went and
 * whether it is late (M1). `restaurant_id` is either id - the CRM's
 * account id or ours (lib/restaurant-ref.ts). Test orders are hidden
 * unless asked for. `since` returns only rows changed after it
 * (orders.updated_at) so the CRM can poll every twenty seconds for
 * almost nothing; the counts are always the whole day's.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const q = req.nextUrl.searchParams;
  const date = (q.get("date") ?? "").trim();
  const tz = (q.get("tz") ?? DEFAULT_ORDERS_TZ).trim() || DEFAULT_ORDERS_TZ;
  const window = date ? localDayWindow(date, tz) : null;
  if (!window) {
    return NextResponse.json(
      { error: "date is required as YYYY-MM-DD, and tz must be an IANA zone name", code: "invalid_date" },
      { status: 400 }
    );
  }
  const includeTest = ["1", "true", "yes"].includes((q.get("include_test") ?? "").toLowerCase());
  const sinceRaw = q.get("since");
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;

  // Either id. A reference nothing matches is a 404, not an empty day - an
  // empty day is a fact about the restaurant, this is a fact about the id.
  let restaurantId: string | null = null;
  const ref = q.get("restaurant_id");
  if (ref) {
    const r = await findRestaurantByRef<{ id: string }>(ref, "id");
    if (!r) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
    restaurantId = r.id;
  }

  const admin = supabaseAdmin();
  let query = admin
    .from("orders")
    .select(ORDER_LIST_SELECT)
    .gte("received_at", window.start)
    .lt("received_at", window.end)
    .order("received_at", { ascending: true })
    .limit(ORDERS_LIST_LIMIT);
  if (restaurantId) query = query.eq("restaurant_id", restaurantId);
  if (!includeTest) query = query.neq("source", "test");
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const orders = (data ?? []) as unknown as OrderRowInput[];

  const now = Date.now();
  const ctx = await loadOrderContext(orders);
  const rows: OrderListRow[] = orders.map((o) =>
    shapeOrderRow(o, ctx.restaurants.get(o.restaurant_id) ?? { id: o.restaurant_id, crm_restaurant_id: null, name: null }, ctx.jobsByOrder.get(o.id) ?? [], now)
  );
  const sorted = sortOrderRows(rows, now);

  return NextResponse.json({
    date,
    tz,
    generated_at: new Date(now).toISOString(),
    since,
    truncated: orders.length === ORDERS_LIST_LIMIT,
    counts: orderCounts(sorted),
    orders: changedSince(sorted, since),
    // Orders are never deleted here (a cancellation is a status), so a
    // poller has nothing to remove. Present so the shape is stable.
    deleted: [] as string[],
  });
}
