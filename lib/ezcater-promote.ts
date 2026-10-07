import { supabaseAdmin } from "./supabase-server";
import { ingestOrder, moneyVariance, sendCancellationEmail } from "./canonical";
import { ezCaterOrderToCanonical, type EzCaterCanonicalOrder, type EzCaterOrder } from "./ezcater";
import { mapEzCaterOrder } from "./ezcater-client";
import { queueOrderToPrinters } from "./print-queue";
import { reprintBy } from "./print-policy";

/**
 * ezCater orders into the kitchen and the books (migration 050).
 *
 * A stored ezCater order (`ezcater_orders`, migration 045) is PROMOTED into
 * `orders` - the one table the printer queue, the tablet, the unaccepted
 * alerts and the CRM's accounting feed read - when two things are true:
 *
 *   - its location has `send_to_kitchen` on (off by default; set by hand on
 *     /admin/ezcater, Willie Mae's first), and
 *   - its hand-off time is within the location's `kitchen_lead_hours`
 *     (default 24). A catering order accepted Monday for Thursday is held
 *     until Wednesday, then printed: a ticket three days early gets lost, and
 *     the print queue expires old jobs anyway.
 *
 * Promotion happens at ingest when the order is already that close, else on
 * the minute monitor cron (`promoteDueEzCaterOrders`). It goes through
 * `ingestOrder` like every other source, so the ticket, the tablet alert and
 * the accounting row are the ordinary ones. What is ezCater's own:
 *
 *   - `ezcater_fee` = customer total - catererTotalDue (Matt, 2026-09-28),
 *     stored on the order and sent on the accounting feed. The CRM prices the
 *     order on the restaurant's delivery deal and takes the fee off PFD's side.
 *     No catererTotalDue = no fee = the CRM excludes the order `money_null`,
 *     loudly, rather than guessing.
 *   - A modification after promotion updates the order and reprints it with
 *     "UPDATED ORDER" on top. Unlike a Zuppler adjustment, a catering change is
 *     usually the food itself (headcount, items), so the kitchen must see it.
 *   - A cancellation after promotion cancels the order the way a Zuppler one
 *     is cancelled: queued tickets pulled, an email restaurant emailed,
 *     printed_at never cleared.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DEFAULT_KITCHEN_LEAD_HOURS = 24;
export const EZCATER_TICKET_BANNER = "*** ezCATER CATERING ***";
export const EZCATER_UPDATED_BANNER = "*** UPDATED ORDER - replaces the earlier ticket ***";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What ezCater kept: the customer's total less what ezCater pays PFD. Null when ezCater did not say what it pays. */
export function ezCaterFeeOf(order: Pick<EzCaterOrder, "money">): number | null {
  const due = order.money.catererTotalDue;
  if (due === null || due === undefined || !Number.isFinite(due)) return null;
  return round2(order.money.total - due);
}

export type PromotionDecision = { kind: "promote" } | { kind: "wait"; promoteAt: string } | { kind: "skip"; reason: string };

/** Pure: should this stored order go to the kitchen now? */
export function promotionDecision(args: {
  status: string;
  promotedOrderId: string | null;
  eventTime: string | null;
  sendToKitchen: boolean;
  leadHours: number | null | undefined;
  now: Date;
}): PromotionDecision {
  if (args.promotedOrderId) return { kind: "skip", reason: "already in the kitchen" };
  if (args.status !== "accepted") return { kind: "skip", reason: `order is ${args.status}` };
  if (!args.sendToKitchen) return { kind: "skip", reason: "location's kitchen switch is off" };
  const lead = Number.isFinite(args.leadHours) && (args.leadHours as number) > 0 ? (args.leadHours as number) : DEFAULT_KITCHEN_LEAD_HOURS;
  const due = args.eventTime ? new Date(args.eventTime).getTime() : NaN;
  // No readable hand-off time: send it now rather than hold it forever.
  if (!Number.isFinite(due)) return { kind: "promote" };
  const promoteAtMs = due - lead * 3_600_000;
  if (args.now.getTime() >= promoteAtMs) return { kind: "promote" };
  return { kind: "wait", promoteAt: new Date(promoteAtMs).toISOString() };
}

/** The order the kitchen gets: #90's canonical mapping, the fee, and the catering banner leading the NOTE box. */
export function ezCaterKitchenOrder(order: EzCaterOrder, restaurant: { id: string; name: string | null }, opts: { updated?: boolean } = {}): EzCaterCanonicalOrder {
  const base = ezCaterOrderToCanonical(order, restaurant);
  const banner = [opts.updated ? EZCATER_UPDATED_BANNER : null, EZCATER_TICKET_BANNER].filter(Boolean).join("\n");
  return {
    ...base,
    notes: [banner, base.notes].filter(Boolean).join("\n"),
    ezcaterFee: ezCaterFeeOf(order),
  };
}

export interface KitchenSyncResult {
  status: "promoted" | "waiting" | "skipped" | "updated" | "unchanged" | "cancelled" | "error";
  detail?: string;
  orderId?: string;
}

async function loadStored(ezcaterOrderId: string) {
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("ezcater_orders")
    .select("ezcater_order_id, caterer_uuid, restaurant_id, status, event_time, raw_payload, promoted_order_id, modified_at, promoted_at, ezcater_locations(name, active, send_to_kitchen, kitchen_lead_hours), restaurants(id, name)")
    .eq("ezcater_order_id", ezcaterOrderId)
    .maybeSingle();
  return row as any;
}

async function recordPromoteError(ezcaterOrderId: string, detail: string) {
  console.error("ezCater promotion failed", { ezcaterOrderId, detail });
  await supabaseAdmin().from("ezcater_orders").update({ promote_error: detail.slice(0, 500) }).eq("ezcater_order_id", ezcaterOrderId);
}

/**
 * Bring one stored order's kitchen side up to date: promote it when due,
 * apply a modification or a cancellation to an order already promoted.
 * Never throws - the webhook must answer ezCater whatever happens here.
 */
export async function syncEzCaterOrderToKitchen(ezcaterOrderId: string, opts: { now?: Date; changed?: boolean; force?: boolean } = {}): Promise<KitchenSyncResult> {
  try {
    const row = await loadStored(ezcaterOrderId);
    if (!row) return { status: "skipped", detail: "not stored" };
    if (row.promoted_order_id) {
      if (row.status === "cancelled") return await cancelInKitchen(row);
      if (opts.changed) return await updateInKitchen(row);
      return { status: "unchanged", orderId: row.promoted_order_id };
    }
    const loc = row.ezcater_locations ?? {};
    const decision = promotionDecision({
      status: row.status,
      promotedOrderId: row.promoted_order_id,
      eventTime: row.event_time,
      sendToKitchen: !!loc.send_to_kitchen && !!loc.active,
      leadHours: loc.kitchen_lead_hours,
      now: opts.now ?? new Date(),
    });
    if (decision.kind === "skip") return { status: "skipped", detail: decision.reason };
    // "Send to kitchen now" on /admin/ezcater skips the lead-time wait, never the switch.
    if (decision.kind === "wait" && !opts.force) return { status: "waiting", detail: `prints ${decision.promoteAt}` };
    return await promote(row);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await recordPromoteError(ezcaterOrderId, detail).catch(() => undefined);
    return { status: "error", detail };
  }
}

async function promote(row: any): Promise<KitchenSyncResult> {
  const order = mapEzCaterOrder(row.raw_payload);
  const restaurant = row.restaurants ?? { id: row.restaurant_id, name: null };
  if (!restaurant.id) return { status: "skipped", detail: "no restaurant on the stored order" };
  const result = await ingestOrder(ezCaterKitchenOrder(order, restaurant));
  if (result.status === "error" || !result.orderId) {
    await recordPromoteError(row.ezcater_order_id, result.error ?? `ingest ${result.status} with no order id`);
    return { status: "error", detail: result.error ?? result.status };
  }
  const now = new Date().toISOString();
  await supabaseAdmin()
    .from("ezcater_orders")
    .update({ promoted_order_id: result.orderId, promoted_at: now, promote_error: null })
    .eq("ezcater_order_id", row.ezcater_order_id);
  console.log("ezCater order sent to the kitchen", { ezcaterOrderId: row.ezcater_order_id, orderId: result.orderId, ingest: result.status });
  return { status: "promoted", orderId: result.orderId, detail: result.status };
}

/** A modification after promotion: the order row takes the new content and the kitchen gets an UPDATED ticket. */
async function updateInKitchen(row: any): Promise<KitchenSyncResult> {
  const admin = supabaseAdmin();
  const order = mapEzCaterOrder(row.raw_payload);
  const restaurant = row.restaurants ?? { id: row.restaurant_id, name: null };
  const k = ezCaterKitchenOrder(order, restaurant, { updated: true });
  const { data: existing } = await admin.from("orders").select("id, restaurant_id, received_at, cancelled_at").eq("id", row.promoted_order_id).maybeSingle();
  if (!existing) return { status: "error", detail: "promoted order no longer exists" };
  if (existing.cancelled_at) return { status: "unchanged", orderId: existing.id, detail: "order already cancelled" };
  const { error } = await admin
    .from("orders")
    .update({
      order_type: k.orderType ?? null,
      due_time: k.dueTime ?? null,
      customer_name: k.customerName ?? null,
      customer_phone: k.customerPhone ?? null,
      customer_address: k.customerAddress ?? null,
      items: k.items,
      items_total: k.itemsTotal ?? null,
      tax: k.tax ?? null,
      delivery_fee: k.deliveryFee ?? null,
      tip: k.tip ?? null,
      customer_total: k.customerTotal ?? null,
      ezcater_fee: k.ezcaterFee ?? null,
      notes: k.notes ?? null,
      money_variance: moneyVariance(k),
      raw_payload: k.rawPayload ?? null,
    })
    .eq("id", existing.id);
  if (error) return { status: "error", detail: error.message };
  const queued = await queueOrderToPrinters(existing.id, existing.restaurant_id, { queuedBy: reprintBy("ezcater-update"), receivedAt: existing.received_at });
  console.log("ezCater order modified after it reached the kitchen - reprinted", { ezcaterOrderId: row.ezcater_order_id, orderId: existing.id, queued: queued.queued.length, refusal: queued.refusal ?? null });
  return { status: "updated", orderId: existing.id, detail: queued.refusal ? `updated; reprint not queued: ${queued.message ?? queued.refusal}` : `updated; reprinted on ${queued.queued.length}` };
}

/** A cancellation after promotion - the Zuppler cancel, for ezCater. */
async function cancelInKitchen(row: any): Promise<KitchenSyncResult> {
  const admin = supabaseAdmin();
  const { data: existing } = await admin.from("orders").select("id, printed_at, cancelled_at").eq("id", row.promoted_order_id).maybeSingle();
  if (!existing) return { status: "error", detail: "promoted order no longer exists" };
  if (existing.cancelled_at) return { status: "unchanged", orderId: existing.id, detail: "already cancelled" };
  const now = new Date().toISOString();
  // printed_at is never cleared: a ticket that came out is a fact.
  await admin.from("orders").update({ status: "cancelled", cancelled_at: now }).eq("id", existing.id);
  if (existing.printed_at) {
    console.error("ezCater order CANCELLED AFTER PRINTING - the kitchen may have started it:", JSON.stringify({ orderId: existing.id, ezcaterOrderId: row.ezcater_order_id, printed_at: existing.printed_at, cancelled_at: now }));
  }
  await admin
    .from("print_jobs")
    .update({ status: "failed", error: "order cancelled", finished_at: now })
    .eq("order_id", existing.id)
    .in("status", ["queued", "claimed"]);
  await sendCancellationEmail(existing.id);
  return { status: "cancelled", orderId: existing.id };
}

/**
 * The minute monitor cron's sweep: every stored, live order at a kitchen-on
 * location whose hand-off is now inside its lead time. Bounded per run.
 */
export async function promoteDueEzCaterOrders(now = new Date(), limit = 25): Promise<{ checked: number; promoted: number; errors: number }> {
  const admin = supabaseAdmin();
  // The longest lead a location may have (migration 050's CHECK) bounds the window.
  const horizon = new Date(now.getTime() + 168 * 3_600_000).toISOString();
  const { data: rows, error } = await admin
    .from("ezcater_orders")
    .select("ezcater_order_id, event_time, ezcater_locations!inner(send_to_kitchen, active)")
    .eq("status", "accepted")
    .is("promoted_order_id", null)
    .eq("ezcater_locations.send_to_kitchen", true)
    .or(`event_time.is.null,event_time.lte.${horizon}`)
    .order("event_time", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) {
    console.error("ezCater promotion sweep: read failed -", error.message);
    return { checked: 0, promoted: 0, errors: 1 };
  }
  let promoted = 0;
  let errors = 0;
  for (const r of rows ?? []) {
    const res = await syncEzCaterOrderToKitchen((r as any).ezcater_order_id, { now });
    if (res.status === "promoted") promoted++;
    if (res.status === "error") errors++;
  }
  return { checked: rows?.length ?? 0, promoted, errors };
}

/** For the admin page and tests: what a location's kitchen setting can be set to. */
export function validLeadHours(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isInteger(v) && v >= 1 && v <= 168 ? v : null;
}
