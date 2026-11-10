import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { queueOrderToPrinters } from "@/lib/print-queue";
import { reprintBy } from "@/lib/print-policy";
import { appDeliveryOutcome } from "@/lib/canonical";
import { notifyRestaurant } from "@/lib/push";
import { cancelRefusal, DEFAULT_ORDERS_TZ, isOrderAction, ORDER_ACTIONS, pickedUpRefusal, reopenRefusal, resendRefusal, SET_READY_MAX, SET_READY_MIN, setReadyMinutes } from "@/lib/crm-orders";
import { retimeOrderForCrm } from "@/lib/order-retime";
import { cancelOrderForCrm, completeOrderOnPickup, reopenCompletedOrder } from "@/lib/order-cancel";
import { resendOrder } from "@/lib/order-resend";
import { isValidTimeZone } from "@/lib/clock";
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
 *   resend      (2026-09-29) the order again to EVERY place the restaurant
 *               receives orders now - printers, PC inbox, tablet - marked
 *               RESENT (lib/order-resend.ts). Allowed for any order
 *               received today in `tz` (default America/Chicago) that is
 *               not cancelled, completed ones included; 409 not_today
 *               after midnight. Body may carry `tz`.
 *
 *   cancel      (2026-10-07) a PHONE order only (cancelRefusal): status
 *               cancelled, unprinted tickets pulled, the email restaurant
 *               told, the tablet pushed "CANCELLED - Order #n". Answers
 *               was_printed so the CRM knows whether the kitchen may have
 *               started it. 409 for any other source, or a cancelled /
 *               completed order. The CRM removes Shipday and refunds.
 *
 *   picked_up   (2026-11-09, Matt: "remove when driver picks up") the CRM
 *               saw the driver pick it up: status completed, so it leaves
 *               the tablet's list for Completed today. Any source. Already
 *               completed answers { ok, already: true }; 409 order_cancelled.
 *
 *   reopen      (2026-11-10, Matt: "uncomplete orders that are accidentally
 *               completed") a completed order received in the last 24 h goes
 *               back to the furthest step it reached (opened / printed / new),
 *               completed_at cleared, the tablet pushed "REOPENED - Order #n".
 *               409 order_not_completed / too_old. Answers { ok, action, reopened, status, pushed }.
 *
 *   set_ready   (2026-11-10, CRM Ticket #1447) dispatch re-times one
 *               accepted order: body { minutes } (1-180, counted from
 *               Accept, the tablet's own meaning). ready_by becomes
 *               accepted_at + minutes; the tablet and Partner app show it
 *               on their next poll. Same refusals as the tablet's Running
 *               late (409 not_accepted, already_ready, order_cancelled,
 *               order_completed), 400 invalid_minutes. Writes the same
 *               cook-time log row, source "crm", actor = the CRM user.
 *               Answers { ok, action, ready_by, ready_minutes, before_ready_by }.
 *
 * reprint / resend_app: 409 on a cancelled or completed order: the food is
 * not to be made, or already was. The actor is the CRM session's email,
 * passed through - the bridge cannot know it otherwise.
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
    .select("id, restaurant_id, order_number, status, source, received_at, customer_name, customer_total")
    .eq("id", params.id)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: "order not found", code: "order_not_found" }, { status: 404 });

  if (action === "cancel") {
    const refusal = cancelRefusal(order);
    if (refusal) return NextResponse.json(refusal, { status: 409 });
    const result = await cancelOrderForCrm(order, actor);
    return NextResponse.json({ ok: true, action, ...result });
  }

  if (action === "resend") {
    const tz = typeof body?.tz === "string" && isValidTimeZone(body.tz) ? body.tz : DEFAULT_ORDERS_TZ;
    const refusal = resendRefusal(order, Date.now(), tz);
    if (refusal) return NextResponse.json(refusal, { status: 409 });
    const { data: full } = await admin.from("orders").select("*").eq("id", order.id).maybeSingle();
    const result = await resendOrder(full ?? order, actor);
    if (!result.destinations.length) {
      return NextResponse.json(
        { error: "this restaurant has nowhere to receive orders - no printer, no email, no tablet", code: "no_destination" },
        { status: 409 }
      );
    }
    const ok = result.channels.every((c) => c.ok);
    return NextResponse.json({
      ok,
      action,
      channels: result.channels,
      note: result.channels.map((c) => `${c.channel}: ${c.detail}`).join(" "),
    });
  }

  if (action === "set_ready") {
    const minutes = setReadyMinutes(body?.minutes);
    if (minutes === null) {
      return NextResponse.json({ error: `minutes must be a whole number from ${SET_READY_MIN} to ${SET_READY_MAX}, counted from Accept`, code: "invalid_minutes" }, { status: 400 });
    }
    // The one write lives in lib/order-retime.ts, with the tablet's own guard and audit row.
    const result = await retimeOrderForCrm(order.id, minutes, actor);
    if ("error" in result) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    return NextResponse.json({ ok: true, action, ready_by: result.ready_by, ready_minutes: result.ready_minutes, before_ready_by: result.before_ready_by });
  }

  if (action === "picked_up") {
    const refusal = pickedUpRefusal(order);
    if (refusal) return NextResponse.json(refusal, { status: 409 });
    if (order.status === "completed") return NextResponse.json({ ok: true, action, already: true });
    const done = await completeOrderOnPickup(order.id);
    return NextResponse.json({ ok: true, action, already: !done.completed, completed_at: done.completed_at });
  }

  if (action === "reopen") {
    const refusal = reopenRefusal(order, Date.now());
    if (refusal) return NextResponse.json(refusal, { status: 409 });
    const result = await reopenCompletedOrder(order, actor);
    return NextResponse.json({ ok: true, action, ...result });
  }

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
