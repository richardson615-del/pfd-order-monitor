import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { ORDER_DETAIL_SELECT, loadOrderContext } from "@/lib/crm-orders-data";
import { appDelivery, orderTimeline, shapeOrderRow, type OrderRowInput } from "@/lib/crm-orders";
import { UUID_RE } from "@/lib/restaurant-ref";

export const dynamic = "force-dynamic";

/**
 * GET /api/crm/orders/:id
 *
 * The whole ticket for one order (M1): everything the list row carries,
 * plus the customer's full phone and address, the items with modifiers
 * and prices as printed, the notes, the money, the order's timeline
 * (received -> printed -> opened -> accepted -> completed/cancelled, with
 * every print attempt), the print jobs, and whether the tablet was told.
 * Never raw_html or raw_payload - the email parser's source can carry
 * card-holder data, and nobody in the office needs it.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "order not found", code: "order_not_found" }, { status: 404 });

  const { data: o, error } = await supabaseAdmin().from("orders").select(ORDER_DETAIL_SELECT).eq("id", params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!o) return NextResponse.json({ error: "order not found", code: "order_not_found" }, { status: 404 });

  const row = o as unknown as OrderRowInput & Record<string, any>;
  const now = Date.now();
  const ctx = await loadOrderContext([row]);
  const jobs = ctx.jobsByOrder.get(row.id) ?? [];
  const restaurant = ctx.restaurants.get(row.restaurant_id) ?? { id: row.restaurant_id, crm_restaurant_id: null, name: null };
  const list = shapeOrderRow(row, restaurant, jobs, now);
  const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

  return NextResponse.json({
    generated_at: new Date(now).toISOString(),
    order: {
      ...list,
      external_id: row.external_id ?? null,
      zuppler_order_uuid: row.source === "zuppler" ? (row.external_id ?? null) : null,
      ticket_restaurant_name: row.ticket_restaurant_name ?? null,
      customer: { name: row.customer_name ?? null, phone: row.customer_phone ?? null, address: row.customer_address ?? null },
      items: Array.isArray(row.items) ? row.items : [],
      notes: row.notes ?? null,
      money: {
        subtotal: num(row.items_total),
        tax: num(row.tax),
        service_fee: num(row.service_fee),
        delivery_fee: num(row.delivery_fee),
        tip: num(row.tip),
        discount: num(row.discount),
        included_tax: num(row.included_tax),
        hidden_fee: num(row.hidden_fee),
        total: num(row.customer_total),
        variance: num(row.money_variance),
      },
      timeline: orderTimeline(row, jobs),
      print_jobs: jobs
        .filter((j) => (j.delivery ?? "epson") === "epson")
        .map((j) => ({
          id: j.id,
          status: j.status,
          device_id: j.device_id ?? null,
          device_name: j.device_name ?? null,
          queued_at: j.queued_at ?? null,
          claimed_at: j.claimed_at ?? null,
          finished_at: j.finished_at ?? null,
          attempts: j.attempts ?? 0,
          error: j.error ?? null,
          queued_by: j.queued_by ?? null,
        })),
      app_delivery: appDelivery(jobs),
    },
  });
}
