import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/crm/accounting/orders
 *
 * Per-order money rows for a date range. Every one of the nine money fields
 * Zuppler sends, plus channel, order type and payment type.
 *
 * PAGINATION (2026-09-19): `limit` (default 1000, max 2000) caps a single
 * response; `offset` (default 0) pages through a range larger than that.
 * `truncated: true` means exactly "this page is full, there may be more" --
 * the caller must request `offset + limit` next, not treat the response as
 * complete. A week carrying partner + chain + backfill volume together
 * crossed 1000 orders for the first time on 2026-09-18 and the CRM's own
 * client silently trusted a truncated single request until then (it now
 * loops on `truncated` -- see prs-crm's `fetchAccountingOrders`). Ordering
 * is `received_at, id` -- the `id` tiebreaker is REQUIRED for correct
 * paging: two orders sharing the same `received_at` timestamp would
 * otherwise land on either side of a page boundary nondeterministically
 * across requests, silently duplicating or skipping a row.
 *
 * Two further deliberate properties:
 *
 * 1. money_variance is returned on EVERY row, not filtered out. A row that
 *    does not balance is exactly what accounting must not silently average
 *    away, and hiding it here would push the discovery to a disputed
 *    statement months later.
 * 1b. CANCELLED ORDERS ARE EXCLUDED FROM totals. They used to be counted -
 *    seven orders worth $156.34 sat inside the revenue figures - because the
 *    query filtered only on source. They are still RETURNED, in their own
 *    section with their own totals, because a cancellation that arrived after
 *    the ticket printed is a real cost to somebody and hiding it would repeat
 *    the original mistake in the opposite direction.
 * 2. Amounts are returned as numbers in dollars, matching what the customer
 *    was charged. Zuppler's own API speaks cents; that conversion happens
 *    once, at ingest, so no consumer has to know about it.
 */
export async function GET(req: NextRequest) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const q = req.nextUrl.searchParams;
  const from = q.get("from");
  const to = q.get("to");
  if (!from || !to) {
    return NextResponse.json(
      { error: "from and to are required (ISO dates, e.g. 2026-09-01)" },
      { status: 400 }
    );
  }
  const fromISO = new Date(from).toISOString();
  // `to` is inclusive of the whole day, which is how anyone reading a
  // statement means it.
  const toDate = new Date(to);
  toDate.setUTCHours(23, 59, 59, 999);
  const toISO = toDate.toISOString();
  if (isNaN(Date.parse(fromISO)) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: "from/to must be parseable dates" }, { status: 400 });
  }

  // Either id - the CRM's account id or ours (lib/restaurant-ref.ts). This
  // used to be a plain .eq on our uuid, so a CRM account id silently
  // returned zero rows (M1, 2026-09-18). An id neither column knows is a
  // 404 rather than an empty statement.
  let restaurantId: string | null = null;
  const ref = q.get("restaurant_id");
  if (ref) {
    const r = await findRestaurantByRef<{ id: string }>(ref, "id");
    if (!r) return NextResponse.json({ error: "restaurant not found", code: "restaurant_not_found" }, { status: 404 });
    restaurantId = r.id;
  }
  const limit = Math.min(2000, Math.max(1, Number(q.get("limit") || 1000)));
  const offset = Math.max(0, Number(q.get("offset") || 0));

  const admin = supabaseAdmin();
  let query = admin
    .from("orders")
    .select("id, order_number, external_id, source, status, received_at, printed_at, cancelled_at, order_type, channel_id, payment_type, items_total, tax, service_fee, delivery_fee, tip, discount, included_tax, hidden_fee, customer_total, money_variance, restaurant_id, restaurants(name, zuppler_restaurant_id)")
    .gte("received_at", fromISO)
    .lte("received_at", toISO)
    // Test prints are not revenue.
    .neq("source", "test")
    // `id` is a REQUIRED secondary sort key, not cosmetic: `received_at`
    // alone is not unique (multiple orders can share the same timestamp),
    // and without a stable tiebreaker two orders on a page boundary could
    // land on either side of it nondeterministically between requests --
    // silently duplicating one row and skipping another across pages.
    .order("received_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (restaurantId) query = query.eq("restaurant_id", restaurantId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const num = (v: unknown) => (v == null ? null : Number(v));
  const rows = (data ?? []).map((o: any) => ({
    order_id: o.id,
    order_number: o.order_number,
    zuppler_order_uuid: o.source === "zuppler" ? o.external_id : null,
    source: o.source,
    status: o.status,
    received_at: o.received_at,
    printed_at: o.printed_at,
    cancelled_at: o.cancelled_at,
    cancelled: Boolean(o.cancelled_at) || o.status === "cancelled",
    // Cancelled after the ticket was already out. The food may exist, so this
    // is a different commercial event from a cancellation that arrived in
    // time, and a statement should be able to tell them apart.
    cancelled_after_print: Boolean(o.printed_at) && (Boolean(o.cancelled_at) || o.status === "cancelled"),
    restaurant: {
      id: o.restaurant_id,
      name: o.restaurants?.name ?? null,
      zuppler_restaurant_id: o.restaurants?.zuppler_restaurant_id ?? null,
    },
    channel_id: o.channel_id,
    order_type: o.order_type,
    payment_type: o.payment_type,
    money: {
      subtotal: num(o.items_total),
      tax: num(o.tax),
      service_fee: num(o.service_fee),
      delivery_fee: num(o.delivery_fee),
      tip: num(o.tip),
      discount: num(o.discount),
      included_tax: num(o.included_tax),
      hidden_fee: num(o.hidden_fee),
      total: num(o.customer_total),
    },
    // Zero means the components explain the total exactly.
    money_variance: num(o.money_variance),
  }));

  const billable = rows.filter((r) => !r.cancelled);
  const cancelled = rows.filter((r) => r.cancelled);

  const sumOf = (set: any[], f: (r: any) => number | null) =>
    Math.round(set.reduce((s, r) => s + (f(r) ?? 0), 0) * 100) / 100;
  const sum = (f: (r: any) => number | null) => sumOf(billable, f);

  const unreconciled = rows.filter((r) => (r.money_variance ?? 0) !== 0);

  return NextResponse.json({
    from: fromISO,
    to: toISO,
    count: rows.length,
    // Page-full signal, not "here's everything" -- see this route's own
    // pagination comment above. offset/limit echoed back so a paging
    // client never has to reconstruct what it asked for.
    truncated: rows.length === limit,
    offset,
    limit,
    // Named so nobody can mistake what the totals cover.
    billable_count: billable.length,
    cancelled_count: cancelled.length,
    totals: {
      subtotal: sum((r) => r.money.subtotal),
      tax: sum((r) => r.money.tax),
      service_fee: sum((r) => r.money.service_fee),
      delivery_fee: sum((r) => r.money.delivery_fee),
      tip: sum((r) => r.money.tip),
      discount: sum((r) => r.money.discount),
      total: sum((r) => r.money.total),
    },
    // Excluded from `totals` above. Reported rather than dropped: a
    // cancellation after the ticket printed still cost somebody something.
    cancelled: {
      count: cancelled.length,
      total: sumOf(cancelled, (r) => r.money.total),
      after_print_count: cancelled.filter((r) => r.cancelled_after_print).length,
      after_print_total: sumOf(
        cancelled.filter((r) => r.cancelled_after_print),
        (r) => r.money.total
      ),
      order_ids: cancelled.map((r) => r.order_id),
    },
    reconciliation: {
      // Stated up front so a consumer cannot use the totals without seeing it.
      all_balance: unreconciled.length === 0,
      unreconciled_count: unreconciled.length,
      unreconciled_order_ids: unreconciled.map((r) => r.order_id),
    },
    orders: rows,
  });
}
