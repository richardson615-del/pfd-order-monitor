import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/crm/accounting/orders
 *
 * Per-order money rows for a date range. Every one of the nine money fields
 * Zuppler sends, plus channel, order type and payment type.
 *
 * Two deliberate properties:
 *
 * 1. money_variance is returned on EVERY row, not filtered out. A row that
 *    does not balance is exactly what accounting must not silently average
 *    away, and hiding it here would push the discovery to a disputed
 *    statement months later.
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

  const restaurantId = q.get("restaurant_id");
  const limit = Math.min(2000, Math.max(1, Number(q.get("limit") || 1000)));

  const admin = supabaseAdmin();
  let query = admin
    .from("orders")
    .select("id, order_number, external_id, source, status, received_at, order_type, channel_id, payment_type, items_total, tax, service_fee, delivery_fee, tip, discount, included_tax, hidden_fee, customer_total, money_variance, restaurant_id, restaurants(name, zuppler_restaurant_id)")
    .gte("received_at", fromISO)
    .lte("received_at", toISO)
    // Test prints are not revenue.
    .neq("source", "test")
    .order("received_at", { ascending: true })
    .limit(limit);
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

  const sum = (f: (r: any) => number | null) =>
    Math.round(rows.reduce((s, r) => s + (f(r) ?? 0), 0) * 100) / 100;

  const unreconciled = rows.filter((r) => (r.money_variance ?? 0) !== 0);

  return NextResponse.json({
    from: fromISO,
    to: toISO,
    count: rows.length,
    truncated: rows.length === limit,
    totals: {
      subtotal: sum((r) => r.money.subtotal),
      tax: sum((r) => r.money.tax),
      service_fee: sum((r) => r.money.service_fee),
      delivery_fee: sum((r) => r.money.delivery_fee),
      tip: sum((r) => r.money.tip),
      discount: sum((r) => r.money.discount),
      total: sum((r) => r.money.total),
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
