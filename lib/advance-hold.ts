import { supabaseAdmin } from "./supabase-server";
import { ADVANCE_RELEASE_QUEUED_BY, ADVANCE_RELEASE_STALE_MS, advanceHoldMinutes, advanceReleaseDue, maxAdvanceWindowMinutes } from "./advance-order";
import { emailSkipReason } from "./email-routing";

export * from "./advance-order";

/**
 * The database half of the advance-order hold (CRM Ticket #1429). The rules,
 * and why an order can not be held and then never printed, are in
 * lib/advance-order.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AdvanceReleaseResult {
  checked: number;
  released: number;
  restamped: number;
  /** Orders put on the tablet / Partner app this run (061). */
  tablets: number;
  errors: number;
}

/**
 * The minute sweep: queue the paper for every held order whose release time
 * has come. Never throws (the caller is the health cron); a failure for one
 * order is counted and the rest go on.
 */
export async function releaseAdvanceOrders(now: number = Date.now(), windowMinutes: number = advanceHoldMinutes()): Promise<AdvanceReleaseResult> {
  const out: AdvanceReleaseResult = { checked: 0, released: 0, restamped: 0, tablets: 0, errors: 0 };
  if (windowMinutes <= 0) return out;
  const admin = supabaseAdmin();
  const nowIso = new Date(now).toISOString();

  // Released jobs still waiting for their printer keep their "asked for just now" stamp, so the age rule never expires them.
  try {
    const { data: waiting } = await admin.from("print_jobs").select("id").eq("queued_by", ADVANCE_RELEASE_QUEUED_BY).in("status", ["queued", "held"]).limit(200);
    if (waiting?.length) {
      const { error } = await admin
        .from("print_jobs")
        .update({ manual_reprint_at: nowIso })
        .in("id", waiting.map((j: any) => j.id));
      if (error) out.errors++;
      else out.restamped = waiting.length;
    }
  } catch (err) {
    out.errors++;
    console.error("advance hold: re-stamp failed -", err instanceof Error ? err.message : err);
  }

  let orders: any[] = [];
  try {
    const { data, error } = await admin
      .from("orders")
      .select("id, restaurant_id, source, due_time, received_at, customer_total")
      .not("due_time", "is", null)
      .lte("due_time", new Date(now + maxAdvanceWindowMinutes(windowMinutes) * 60_000).toISOString())
      .gte("due_time", new Date(now - ADVANCE_RELEASE_STALE_MS).toISOString())
      .is("printed_at", null)
      .is("cancelled_at", null)
      .is("completed_at", null)
      .limit(300);
    if (error) throw new Error(error.message);
    orders = (data ?? []).filter((o: any) => o.source !== "test" && o.source !== "ezcater" && advanceReleaseDue(o, now, windowMinutes));
  } catch (err) {
    out.errors++;
    console.error("advance hold: could not read due orders -", err instanceof Error ? err.message : err);
    return out;
  }
  out.checked = orders.length;
  if (!orders.length) return out;

  let sent: Set<string>;
  try {
    sent = await ordersAlreadySent(orders.map((o) => o.id));
  } catch (err) {
    out.errors++;
    console.error("advance hold: could not read existing jobs -", err instanceof Error ? err.message : err);
    return out;
  }

  for (const o of orders) {
    // The tablet and app first, and for every due order: its paper may
    // already be out (a reprint from the CRM) while its screen is still held.
    try {
      if (await releaseToTablet(o.id)) out.tablets++;
    } catch (err) {
      out.errors++;
      console.error("advance hold: could not release to the tablet", o.id, "-", err instanceof Error ? err.message : err);
    }
    if (sent.has(o.id)) continue;
    try {
      const r = await sendOrderToKitchen(o.id, ADVANCE_RELEASE_QUEUED_BY, nowIso);
      if (r.sent) {
        out.released++;
        console.log("advance hold RELEASED", JSON.stringify({ order: o.id, due: o.due_time, to: r.to }));
      }
    } catch (err) {
      out.errors++;
      console.error("advance hold: could not release", o.id, "-", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/**
 * Orders whose ticket already went out: a printer job (queued at ingest,
 * released, or reprinted by hand) or the PC email. A tablet push row
 * (delivery "app") is not the ticket and does not count.
 */
export async function ordersAlreadySent(orderIds: string[]): Promise<Set<string>> {
  if (!orderIds.length) return new Set();
  const admin = supabaseAdmin();
  const { data, error } = await admin.from("print_jobs").select("order_id, device_id, delivery").in("order_id", orderIds);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).filter((j: any) => j.device_id != null || j.delivery === "email").map((j: any) => j.order_id));
}

export type SendToKitchenResult =
  | { sent: true; to: "printer" | "email" | "tablet"; printers?: number }
  | { sent: false; reason: "already_sent" | "no_printer" | "zuppler_emails_it" | "not_found" };

/**
 * Send one order's ticket to the kitchen now: the paper to every active
 * printer, or the PC email for an email restaurant. The minute sweep calls it
 * at an order's release time; dispatch calls it early with Send to kitchen
 * (POST /api/crm/orders/:id/actions {action:"send_to_kitchen"}). Never sends
 * twice: an order that already has a printer job or a PC email is left alone.
 */
export async function sendOrderToKitchen(orderId: string, queuedBy: string, nowIso: string = new Date().toISOString()): Promise<SendToKitchenResult> {
  const admin = supabaseAdmin();
  // 061: the tablet and Partner app get it now too (alert included), whatever else follows.
  const tablet = await releaseToTablet(orderId);
  if ((await ordersAlreadySent([orderId])).has(orderId)) return tablet ? { sent: true, to: "tablet" } : { sent: false, reason: "already_sent" };
  const { data: order } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!order) return { sent: false, reason: "not_found" };
  const { data: restaurant } = await admin.from("restaurants").select("*").eq("id", order.restaurant_id).maybeSingle();
  if (!restaurant) return { sent: false, reason: "not_found" };

  if (restaurant.print_method === "email") {
    if (emailSkipReason(restaurant, order)) return tablet ? { sent: true, to: "tablet" } : { sent: false, reason: "zuppler_emails_it" };
    const { deliverByEmail } = await import("./canonical");
    await deliverByEmail({ orderId, restaurant, order });
    return { sent: true, to: "email" };
  }

  const { data: devices } = await admin.from("print_devices").select("id").eq("restaurant_id", order.restaurant_id).eq("is_active", true);
  if (!devices?.length) return tablet ? { sent: true, to: "tablet" } : { sent: false, reason: "no_printer" };
  const { error } = await admin
    .from("print_jobs")
    .insert(devices.map((d: any) => ({ order_id: orderId, device_id: d.id, queued_by: queuedBy, manual_reprint_at: nowIso })));
  if (error) throw new Error(error.message);
  return { sent: true, to: "printer", printers: devices.length };
}

/**
 * Put a held order on the restaurant's tablet and Partner app now (061, Kayla
 * 2026-11-12): clears kitchen_hold_until and sends the new-order alert the
 * ingest held back. Exactly once: only the call that clears the hold sends,
 * and deliverToApp itself refuses a second alert for one order. True when
 * this call released it; false when it was not held (or already released).
 */
export async function releaseToTablet(orderId: string): Promise<boolean> {
  const admin = supabaseAdmin();
  const { data: rows, error } = await admin
    .from("orders")
    .update({ kitchen_hold_until: null })
    .eq("id", orderId)
    .not("kitchen_hold_until", "is", null)
    .select("id, restaurant_id, order_number, ticket_no, source, customer_name, customer_total");
  if (error) throw new Error(error.message);
  const order = rows?.[0];
  if (!order) return false;
  const { data: restaurant } = await admin.from("restaurants").select("app_expected").eq("id", order.restaurant_id).maybeSingle();
  const { deliverToApp } = await import("./canonical");
  const { displayOrderNo } = await import("./order-label");
  await deliverToApp({
    orderId: order.id,
    restaurantId: order.restaurant_id,
    appExpected: !!restaurant?.app_expected,
    orderNumber: displayOrderNo(order),
    customerName: order.customer_name,
    customerTotal: order.customer_total,
  });
  return true;
}
