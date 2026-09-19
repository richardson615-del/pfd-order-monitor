import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { ORDER_LIST_SELECT, loadOrderContext } from "@/lib/crm-orders-data";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { ingestOrder } from "@/lib/canonical";
import { parsePhoneOrder, phoneOrderFingerprint, phoneOrderToCanonical, storedFingerprint } from "@/lib/phone-order";
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

/**
 * POST /api/crm/orders - a phone order taken in the CRM (O1, 2026-09-18).
 *
 * Body: lib/phone-order.ts parsePhoneOrder(). The order is stored with
 * `source: 'phone'` through the same ingestOrder() every Zuppler order goes
 * through, so the paper, the tablet and the AEM email are decided by
 * orderDestinations() exactly as they are for any other order, and
 * orders.status means what it always meant.
 *
 * Idempotent on (source, external_id): the CRM's phone_orders id. A retry
 * with the same content answers 200 with the row it already made; the same
 * id with different content is 409 - the kitchen already has the first
 * order, and an id is not allowed to mean two of them. 422 when neither
 * restaurant column knows the id; 400 for anything the parser refuses,
 * with `code` naming the field.
 *
 * Returns the list row (the same shape GET returns) so the CRM can show it
 * without a second call, plus `id`.
 */
export async function POST(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const parsed = parsePhoneOrder(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: parsed.code }, { status: 400 });
  const order = parsed.order;

  const restaurant = await findRestaurantByRef<{ id: string; name: string | null }>(order.restaurant_ref, "id, name");
  if (!restaurant) {
    return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 422 });
  }

  const fingerprint = phoneOrderFingerprint(order);
  const admin = supabaseAdmin();

  // The row this id already made, if any - checked here as well as inside
  // ingestOrder because only this route knows whether the retry is honest.
  const findExisting = () =>
    admin.from("orders").select("id, raw_payload").eq("source", "phone").eq("external_id", order.external_id).maybeSingle();

  const { data: before } = await findExisting();
  if (before) {
    const conflict = await conflictResponse(before, fingerprint);
    if (conflict) return conflict;
    return NextResponse.json({ ok: true, created: false, id: before.id, order: await listRow(before.id) }, { status: 200 });
  }

  const result = await ingestOrder(phoneOrderToCanonical(order, restaurant, { fingerprint }));
  if (result.status === "error") return NextResponse.json({ error: result.error ?? "could not store the order" }, { status: 500 });

  if (result.status === "created") {
    console.log("phone order created", JSON.stringify({ orderId: result.orderId, externalId: order.external_id, restaurant: restaurant.id, actor: order.actor }));
    const row = await listRow(result.orderId!);
    return NextResponse.json({
      ok: true,
      created: true,
      id: result.orderId,
      order: row,
      // Stored regardless: a real order is never refused for a setup gap. But
      // said out loud, because "created" with nowhere to go is the case the
      // dispatcher needs to hear about while the customer is still on the line.
      ...(row && row.destinations.length === 0
        ? { warning: "this restaurant has no printer, tablet or ticket email configured - the order is stored but nobody there has been told" }
        : {}),
    }, { status: 201 });
  }

  // "duplicate": either a retry raced us between the lookup and the insert
  // (a phone row now exists - answer from it, or refuse if it differs), or
  // ingestOrder's cross-source guard matched a same-numbered order from
  // another source in the last day. The second is a 409 too: the CRM chose
  // an order_number a Zuppler order already wears, and nothing was written.
  const { data: after } = await findExisting();
  if (after) {
    const conflict = await conflictResponse(after, fingerprint);
    if (conflict) return conflict;
    return NextResponse.json({ ok: true, created: false, id: after.id, order: await listRow(after.id) }, { status: 200 });
  }
  return NextResponse.json(
    {
      error: `order_number ${order.order_number} was used by another order at this restaurant in the last day - send a different order_number`,
      code: "order_number_conflict",
      id: result.orderId ?? null,
    },
    { status: 409 }
  );
}

/** 409 when the row under this external_id was made from a different payload; null when it is the same order. */
async function conflictResponse(existing: { id: string; raw_payload: unknown }, fingerprint: string) {
  const stored = storedFingerprint(existing.raw_payload);
  if (stored === fingerprint) return null;
  return NextResponse.json(
    {
      error: "an order with this external_id already exists with different contents - use a new external_id for a different order",
      code: "external_id_conflict",
      id: existing.id,
    },
    { status: 409 }
  );
}

/** The GET list row for one order, so a POST answers with the same shape the dashboard polls. */
async function listRow(orderId: string): Promise<OrderListRow | null> {
  const { data } = await supabaseAdmin().from("orders").select(ORDER_LIST_SELECT).eq("id", orderId).maybeSingle();
  if (!data) return null;
  const o = data as unknown as OrderRowInput;
  const now = Date.now();
  const ctx = await loadOrderContext([o]);
  return shapeOrderRow(o, ctx.restaurants.get(o.restaurant_id) ?? { id: o.restaurant_id, crm_restaurant_id: null, name: null }, ctx.jobsByOrder.get(o.id) ?? [], now);
}
