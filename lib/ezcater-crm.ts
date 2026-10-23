import { supabaseAdmin } from "./supabase-server";
import { ezCaterTokenConfigured } from "./ezcater-client";
import { EZCATER_SUBSCRIBED_EVENTS } from "./ezcater-admin";

/**
 * The CRM's ezCater tab (Matt, 2026-10-21: "an ezCater tab on the CRM where
 * we can see all ezCater orders, connect restaurants and see connected
 * restaurants"). /api/crm/ezcater reads through here on CRM_WRITE_KEY; its
 * writes call the same ezcater-admin functions /admin/ezcater does, so there
 * is one way to link, switch on and send to the kitchen.
 *
 * What the CRM is given: no webhook secret, no customer phone, no raw
 * payload. The customer's name, the items and the notes (headcount) are what
 * a dispatcher needs to recognise a catering order; the rest stays here.
 */

export interface EzCaterOrderRowIn {
  ezcater_order_id: string;
  caterer_uuid: string;
  restaurant_id: string | null;
  order_number: string | null;
  status: string;
  fulfillment: string | null;
  event_time: string | null;
  customer_total: number | string | null;
  caterer_total_due: number | string | null;
  event_count: number | null;
  modified_at: string | null;
  cancelled_at: string | null;
  first_seen_at: string | null;
  promoted_order_id: string | null;
  promoted_at: string | null;
  promote_error: string | null;
  canonical: Record<string, unknown> | null;
}

export interface EzCaterCrmOrder {
  id: string;
  orderNumber: string | null;
  catererUuid: string;
  restaurantId: string | null;
  status: "accepted" | "cancelled" | string;
  fulfillment: string | null;
  eventTime: string | null;
  placedAt: string | null;
  customerName: string | null;
  items: string[];
  notes: string | null;
  customerTotal: number | null;
  catererTotalDue: number | null;
  ezcaterFee: number | null;
  modified: boolean;
  firstSeenAt: string | null;
  /** Where it is: waiting for its lead time, in the kitchen, failed to promote, or cancelled. */
  stage: "waiting" | "in_kitchen" | "promote_failed" | "cancelled";
  promotedAt: string | null;
  promoteError: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Pure: one stored ezCater order as the CRM shows it. */
export function toCrmOrder(r: EzCaterOrderRowIn): EzCaterCrmOrder {
  const c = r.canonical ?? {};
  const total = num(r.customer_total);
  const due = num(r.caterer_total_due);
  const items = Array.isArray(c.items) ? (c.items as Array<{ name?: unknown }>).map((i) => str(i?.name)).filter((n): n is string => !!n) : [];
  const cancelled = r.status === "cancelled" || !!r.cancelled_at;
  const stage: EzCaterCrmOrder["stage"] = cancelled ? "cancelled" : r.promoted_order_id ? "in_kitchen" : r.promote_error ? "promote_failed" : "waiting";
  return {
    id: r.ezcater_order_id,
    orderNumber: r.order_number,
    catererUuid: r.caterer_uuid,
    restaurantId: r.restaurant_id,
    status: r.status,
    fulfillment: r.fulfillment,
    eventTime: r.event_time,
    placedAt: str(c.receivedAt),
    customerName: str(c.customerName),
    items,
    notes: str(c.notes),
    customerTotal: total,
    catererTotalDue: due,
    ezcaterFee: total !== null && due !== null ? Math.round((total - due) * 100) / 100 : null,
    modified: !!r.modified_at,
    firstSeenAt: r.first_seen_at,
    stage,
    promotedAt: r.promoted_at,
    promoteError: r.promote_error,
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: the window asked for, by hand-off time. Default: 7 days back to 30 days ahead, so upcoming catering shows. */
/** One ezCater line as the CRM's payout reads it (2026-10-23): name, quantity, extended price. */
export interface EzCaterAccountingItem {
  name: string;
  quantity: number;
  /** ezCater's extended price for the line, dollars (null when ezCater did not send it). */
  total: number | null;
  modifiers: string[];
}

/**
 * The items of a promoted ezCater order, from its `orders.raw_payload`
 * ({ kind: "ezcater_order", order }). Matt 2026-10-23: the restaurant is paid
 * on its own menu prices, not ezCater's (PFD marks ezCater menus up), so the
 * CRM prices each line itself. Null when the payload is not an ezCater order.
 */
export function ezCaterItemsFromPayload(raw: unknown): EzCaterAccountingItem[] | null {
  const p = raw as { kind?: unknown; order?: { items?: unknown } } | null;
  if (!p || p.kind !== "ezcater_order" || !Array.isArray(p.order?.items)) return null;
  return (p.order!.items as any[]).flatMap((it) => {
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    if (!name) return [];
    const q = Number(it?.quantity);
    const t = it?.total == null ? null : Number(it.total);
    return [{
      name,
      quantity: Number.isFinite(q) && q > 0 ? q : 1,
      total: t !== null && Number.isFinite(t) ? Math.round(t * 100) / 100 : null,
      modifiers: Array.isArray(it?.modifiers) ? it.modifiers.filter((m: unknown) => typeof m === "string") : [],
    }];
  });
}

export function orderWindow(from: string | null, to: string | null, now = new Date()): { from: string; to: string } {
  const day = 86_400_000;
  const f = from && ISO_DAY.test(from) ? `${from}T00:00:00-06:00` : new Date(now.getTime() - 7 * day).toISOString();
  const t = to && ISO_DAY.test(to) ? `${to}T23:59:59-06:00` : new Date(now.getTime() + 30 * day).toISOString();
  return { from: f, to: t };
}

export async function getEzCaterForCrm(window: { from: string; to: string }) {
  const admin = supabaseAdmin();
  const [locations, subscriber, restaurants, orders, receipts] = await Promise.all([
    admin
      .from("ezcater_locations")
      .select("caterer_uuid, name, store_number, address, live, restaurant_id, active, send_to_kitchen, kitchen_lead_hours, subscribed_events, last_synced_at, mapped_at, mapped_by")
      .order("name"),
    admin.from("ezcater_subscriber").select("id").limit(1).maybeSingle(),
    admin.from("restaurants").select("id, name, crm_restaurant_id").order("name"),
    admin
      .from("ezcater_orders")
      .select("ezcater_order_id, caterer_uuid, restaurant_id, order_number, status, fulfillment, event_time, customer_total, caterer_total_due, event_count, modified_at, cancelled_at, first_seen_at, promoted_order_id, promoted_at, promote_error, canonical")
      .gte("event_time", window.from)
      .lte("event_time", window.to)
      .order("event_time", { ascending: true })
      .limit(500),
    admin.from("webhook_receipts").select("received_at, status, detail").eq("source", "ezcater").order("received_at", { ascending: false }).limit(20),
  ]);
  for (const r of [locations, restaurants, orders]) if (r.error) throw new Error(r.error.message);
  return {
    tokenConfigured: ezCaterTokenConfigured(),
    subscriberConfigured: !!subscriber.data,
    subscribedEvents: EZCATER_SUBSCRIBED_EVENTS,
    window,
    locations: locations.data ?? [],
    restaurants: restaurants.data ?? [],
    orders: ((orders.data ?? []) as EzCaterOrderRowIn[]).map(toCrmOrder),
    // Receipts carry no customer data, only the outcome (e.g. "unmapped").
    receipts: receipts.data ?? [],
  };
}
