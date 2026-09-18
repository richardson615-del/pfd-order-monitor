import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { queueOrderToPrinters } from "@/lib/print-queue";
import { reprintBy } from "@/lib/print-policy";
import { appDeliveryOutcome } from "@/lib/canonical";
import { notifyRestaurant } from "@/lib/push";
import { isOrderAction, ORDER_ACTIONS } from "@/lib/crm-orders";
import { UUID_RE } from "@/lib/restaurant-ref";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/orders/:id/actions  { action: "reprint" | "resend_app", actor }
 *
 * The two things the office may do to an order from the CRM (M1 §3), and
 * only because the bridge already had both as primitives - nothing here
 * is a new way to touch an order:
 *
 *   reprint     queueOrderToPrinters(), the same call the tablet's Print
 *               button and the CRM's test order make. Recorded on the job
 *               as queued_by = reprint:crm:<actor> (migration 038), and an
 *               order older than PRINT_MAX_AGE_HOURS prints this once
 *               because somebody asked (manual_reprint_at).
 *   resend_app  notifyRestaurant(), the push every new order gets. The
 *               order's app job row (one per order, migration 020) is
 *               updated with the outcome the same way deliverToApp
 *               records the first push, so "was the tablet told?" stays
 *               one row.
 *
 * 409 on a cancelled or completed order: the food is not to be made, or
 * already was. The actor is the CRM session's email, passed through -
 * the bridge cannot know it otherwise.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: "order not found", code: "order_not_found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const action = body?.action;
  if (!isOrderAction(action)) {
    return NextResponse.json({ error: `action must be one of: ${ORDER_ACTIONS.join(", ")}`, code: "invalid_action" }, { status: 400 });
  }
  const actor = typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : "crm";

  const admin = supabaseAdmin();
  const { data: order } = await admin
    .from("orders")
    .select("id, restaurant_id, order_number, status, received_at, customer_name, customer_total")
    .eq("id", params.id)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: "order not found", code: "order_not_found" }, { status: 404 });
  if (order.status === "cancelled" || order.status === "completed") {
    return NextResponse.json(
      { error: `this order is ${order.status}; nothing is sent for it again`, code: "order_settled" },
      { status: 409 }
    );
  }

  if (action === "reprint") {
    const result = await queueOrderToPrinters(order.id, order.restaurant_id, {
      queuedBy: reprintBy(`crm:${actor}`),
      receivedAt: order.received_at ?? null,
    });
    if (result.refusal) {
      return NextResponse.json({ error: result.message, code: result.refusal }, { status: result.refusal === "restaurant_not_found" ? 404 : 409 });
    }
    return NextResponse.json({
      ok: true,
      action,
      queued: result.queued.map((q) => ({ job_id: q.jobId, device_id: q.deviceId, device_name: q.deviceName, requeued: q.requeued })),
      note: "Queued. The printer prints it on its next poll - typically within a few seconds.",
    });
  }

  // resend_app
  const { data: restaurant } = await admin.from("restaurants").select("id, app_expected").eq("id", order.restaurant_id).maybeSingle();
  if (!restaurant?.app_expected) {
    return NextResponse.json({ error: "this restaurant is not set up to watch orders on the tablet", code: "app_not_expected" }, { status: 409 });
  }
  const total = order.customer_total == null ? null : Number(order.customer_total);
  const push = await notifyRestaurant(order.restaurant_id, {
    title: `New Order #${order.order_number}`,
    body: total ? `${order.customer_name || "Customer"} - $${total.toFixed(2)}` : "Tap to view the order",
    orderId: order.id,
  });
  const now = new Date().toISOString();
  const outcome = appDeliveryOutcome(push, now);
  // The order's one app row (migration 020) records this attempt, and who asked.
  await admin
    .from("print_jobs")
    .update({
      status: outcome.status,
      delivered_count: outcome.delivered_count,
      sent_at: outcome.sent_at,
      send_error: outcome.send_error,
      finished_at: now,
      queued_by: reprintBy(`crm:${actor}`),
    })
    .eq("order_id", order.id)
    .eq("delivery", "app");

  return NextResponse.json({
    ok: outcome.status === "printed",
    action,
    devices_reached: outcome.delivered_count,
    subscriptions: push.subscriptions,
    error: outcome.send_error,
    note:
      outcome.status === "printed"
        ? `Sent to ${outcome.delivered_count} device(s). The tablet should be chiming.`
        : `Nothing reached a tablet: ${outcome.send_error}`,
  });
}
