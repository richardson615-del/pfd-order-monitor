import { supabaseAdmin } from "./supabase-server";
import { ezCaterAction, ezCaterOrderToCanonical, type EzCaterOrder, type EzCaterOrderEvent } from "./ezcater";
import { fetchEzCaterOrderRaw, mapEzCaterOrder } from "./ezcater-client";

/**
 * One ezCater order notification -> the ezcater_orders row (Phase 2).
 *
 * The notification carries no order (`payload: null`), only its id; the
 * order is fetched every time, so a late or repeated notification always
 * stores the order as it is NOW. ezCater has no "modified" event - a
 * modification arrives as a second `accepted` for the same id (docs:
 * order-modifications) - so accepted is an upsert, keyed on ezCater's id.
 *
 * Nothing here touches `orders`: printing is off while ingestion is proven
 * (Matt, 2026-09-28), and every restaurant-facing surface reads `orders`.
 * See migration 045.
 */

export type EzCaterIngestStatus =
  | "created"
  | "updated"
  | "duplicate"
  | "cancelled"
  | "ignored"
  | "unmapped"
  | "inactive"
  | "not_found"
  | "error";

export interface EzCaterIngestResult {
  status: EzCaterIngestStatus;
  detail?: string;
}

export interface EzCaterNotification {
  id?: string;
  parent_type?: string;
  parent_id?: string;
  entity_type?: string;
  entity_id?: string;
  key?: string;
  occurred_at?: string;
}

/** ezCater's "2025-04-15 23:48:21 UTC" -> ISO; null when unreadable. */
export function ezCaterTimeToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The notification's shape, checked; null with the reason when it is not an order event we act on. */
export function readNotification(n: EzCaterNotification): { event: EzCaterOrderEvent } | { ignore: string } {
  if (n.entity_type !== "Order") return { ignore: `entity_type ${n.entity_type ?? "(none)"}` };
  if (n.parent_type && n.parent_type !== "Caterer") return { ignore: `parent_type ${n.parent_type}` };
  if (!n.entity_id || !n.parent_id) return { ignore: "no entity_id or parent_id" };
  if (n.key !== "accepted" && n.key !== "cancelled") return { ignore: `event ${n.key ?? "(none)"} not handled` };
  return { event: { type: n.key, orderId: n.entity_id, catererLocationId: n.parent_id, occurredAt: ezCaterTimeToIso(n.occurred_at) ?? new Date().toISOString() } };
}

/** Money and the lines a kitchen reads - what "the order changed" means for modified_at. */
function substance(o: EzCaterOrder): string {
  return JSON.stringify({ items: o.items, money: o.money, eventTime: o.eventTime, headcount: o.headcount, address: o.deliveryAddress, fulfillment: o.fulfillment });
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function ingestEzCaterNotification(n: EzCaterNotification, deps: { fetchRaw?: (id: string) => Promise<any | null> } = {}): Promise<EzCaterIngestResult> {
  const read = readNotification(n);
  if ("ignore" in read) return { status: "ignored", detail: read.ignore };
  const { event } = read;
  const admin = supabaseAdmin();

  const { data: location } = await admin
    .from("ezcater_locations")
    .select("caterer_uuid, name, active, restaurant_id, restaurants(id, name)")
    .eq("caterer_uuid", event.catererLocationId)
    .maybeSingle();
  if (!location) return { status: "unmapped", detail: `caterer ${event.catererLocationId} not in ezcater_locations - run Sync caterers` };
  if (!location.restaurant_id) return { status: "unmapped", detail: `${location.name}: no restaurant linked` };
  if (!location.active) return { status: "inactive", detail: `${location.name}: location is not active` };

  let raw: any | null;
  try {
    raw = await (deps.fetchRaw ?? fetchEzCaterOrderRaw)(event.orderId);
  } catch (err) {
    return { status: "error", detail: `fetch ${event.orderId}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let order: EzCaterOrder | null = null;
  if (raw) {
    try {
      order = mapEzCaterOrder(raw);
    } catch (err) {
      // Loud and refused: a guessed order would misprice a real payout.
      return { status: "error", detail: `map ${event.orderId}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (order && order.catererLocationId !== event.catererLocationId) {
    // The order says it belongs to a different location than the notification did: never file it under the wrong restaurant.
    return { status: "error", detail: `order ${event.orderId} is caterer ${order.catererLocationId}, notification said ${event.catererLocationId}` };
  }

  const action = ezCaterAction(event, order);
  const { data: existing } = await admin
    .from("ezcater_orders")
    .select("ezcater_order_id, status, canonical, raw_payload, event_count, cancelled_at")
    .eq("ezcater_order_id", event.orderId)
    .maybeSingle();
  const now = new Date().toISOString();

  if (action.kind === "ignore") {
    if (!existing) return { status: "not_found", detail: action.reason };
    return { status: "ignored", detail: action.reason };
  }

  if (action.kind === "cancel") {
    if (!existing && !order) return { status: "cancelled", detail: "cancelled before we ever stored it" };
    const restaurant = (location as any).restaurants ?? { id: location.restaurant_id, name: null };
    // With the order in hand, store it as it now reads; without it (ezCater no longer returns it), only the status moves.
    const row = order ? rowFor(order, raw, restaurant, event) : {};
    if (existing) {
      const { error } = await admin
        .from("ezcater_orders")
        .update({ ...row, status: "cancelled", cancelled_at: existing.cancelled_at ?? now, last_event_key: event.type, last_event_at: event.occurredAt, event_count: (existing.event_count ?? 0) + 1, updated_at: now })
        .eq("ezcater_order_id", event.orderId);
      if (error) return { status: "error", detail: error.message };
      return { status: "cancelled" };
    }
    const { error } = await admin.from("ezcater_orders").insert({ ...rowFor(order!, raw, restaurant, event), status: "cancelled", cancelled_at: now });
    if (error) return { status: "error", detail: error.message };
    return { status: "cancelled", detail: "first seen already cancelled" };
  }

  // upsert
  const restaurant = (location as any).restaurants ?? { id: location.restaurant_id, name: null };
  const row = rowFor(action.order, raw, restaurant, event);
  if (!existing) {
    const { error } = await admin.from("ezcater_orders").insert(row);
    if (error) {
      if ((error as any).code === "23505") return { status: "duplicate" };
      return { status: "error", detail: error.message };
    }
    return { status: "created" };
  }
  const prev = existing.raw_payload ? safeMap(existing.raw_payload) : null;
  const changed = !prev || substance(prev) !== substance(action.order);
  const { error } = await admin
    .from("ezcater_orders")
    .update({
      ...row,
      event_count: (existing.event_count ?? 0) + 1,
      ...(changed ? { modified_at: now } : {}),
      // A re-accept after a cancel means ezCater says the order is live again.
      ...(existing.status === "cancelled" ? { cancelled_at: null } : {}),
      updated_at: now,
    })
    .eq("ezcater_order_id", event.orderId);
  if (error) return { status: "error", detail: error.message };
  if (changed) console.log("ezCater order modified", { ezcaterOrderId: event.orderId, orderNumber: action.order.orderNumber });
  return { status: changed ? "updated" : "duplicate" };
}

function safeMap(raw: any): EzCaterOrder | null {
  try {
    return mapEzCaterOrder(raw);
  } catch {
    return null;
  }
}

function rowFor(order: EzCaterOrder, raw: any, restaurant: { id: string; name: string | null }, event: EzCaterOrderEvent) {
  const canonical = ezCaterOrderToCanonical(order, restaurant);
  return {
    ezcater_order_id: order.orderId,
    caterer_uuid: order.catererLocationId,
    restaurant_id: restaurant.id,
    order_number: order.orderNumber,
    status: order.status,
    fulfillment: order.fulfillment,
    event_time: order.eventTime || null,
    customer_total: order.money.total,
    canonical,
    raw_payload: raw,
    last_event_key: event.type,
    last_event_at: event.occurredAt,
  };
}
