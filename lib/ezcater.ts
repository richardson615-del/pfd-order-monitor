import type { CanonicalOrderInput } from "./canonical";

/**
 * ezCater orders - the scaffold (prs-crm QUEUE row 81, Y6; Nick 2026-09-28:
 * "build it on the order monitor", per prs-crm docs/ezcater-ingestion-spec.md,
 * which puts order ingestion here beside Zuppler and phone orders).
 *
 * What exists: the provider interface, a fake, and the mapping to the
 * canonical order. What does NOT exist yet, on purpose:
 *
 *  - A real client. ezCater will issue one API user for every PFD location,
 *    Orders API only, once PFD gives it a unique email (ticket 313266).
 *    There are no test stores. So nothing here calls ezCater, and nothing
 *    here holds a credential.
 *  - ezCater's own field names. `EzCaterOrder` below is OUR normalised
 *    shape - what the real client must produce - not ezCater's payload.
 *    Their GraphQL shape is not guessed; the client maps it when the API
 *    docs and a real order are in hand (same rule as the CRM's bridge shapes).
 *  - Ingest. `orders.source` has no 'ezcater' value and ingestOrder() is
 *    not called. Landing an order needs a migration adding the source, the
 *    `ezcater_locations` link (spec §3), and the subscriber route - the
 *    next package, once credentials arrive.
 *
 * One fact from the spec that shapes the interface: ezCater's order events
 * fire on ACCEPT, not on placement - an order is not real to the feed until
 * PFD, as caterer of record, accepts it. And `modified` / `cancelled` follow.
 */

export const EZCATER_EVENT_TYPES = ["accepted", "modified", "cancelled"] as const;
export type EzCaterEventType = (typeof EZCATER_EVENT_TYPES)[number];

export interface EzCaterOrderEvent {
  type: EzCaterEventType;
  /** ezCater's order id - with source 'ezcater', the idempotency key. */
  orderId: string;
  /** The ezCater caterer location it belongs to; `ezcater_locations` maps it to a restaurant. */
  catererLocationId: string;
  occurredAt: string;
}

export interface EzCaterOrderItem {
  name: string;
  quantity: number;
  /** Extended price for the line, dollars. */
  total: number | null;
  /** Choices ("Box lunch: Turkey", "No onions"), already as text. */
  modifiers: string[];
  specialInstructions: string | null;
}

/** Our normalised ezCater order - what a real client must produce from ezCater's API. */
export interface EzCaterOrder {
  orderId: string;
  /** The number ezCater shows people (distinct from the id). */
  orderNumber: string;
  catererLocationId: string;
  status: "accepted" | "cancelled";
  fulfillment: "delivery" | "takeout";
  /** When the food must be there / ready, ISO with offset. */
  eventTime: string;
  placedAt: string | null;
  headcount: number | null;
  contact: { name: string | null; phone: string | null };
  deliveryAddress: { street: string | null; city: string | null; state: string | null; zip: string | null; instructions: string | null } | null;
  items: EzCaterOrderItem[];
  money: {
    subtotal: number;
    tax: number | null;
    deliveryFee: number | null;
    tip: number | null;
    /** What the customer paid ezCater. PFD is paid this less ezCater's commission, settled by ezCater (spec §4). */
    total: number;
  };
  notes: string | null;
}

/** The only door to ezCater. A real implementation is the next package; tests use FakeEzCaterProvider. */
export interface EzCaterProvider {
  /** Start receiving order events; returns a stop function. */
  subscribe(onEvent: (event: EzCaterOrderEvent) => Promise<void> | void): Promise<() => void>;
  /** The order as it is now; null when ezCater does not know the id. */
  fetchOrder(orderId: string): Promise<EzCaterOrder | null>;
}

/** What an event means for the order row, before any database is involved. */
export type EzCaterAction = { kind: "upsert"; order: EzCaterOrder } | { kind: "cancel"; orderId: string } | { kind: "ignore"; reason: string };

/**
 * Decide from an event and the fetched order. `accepted` and `modified`
 * upsert (the same id, the latest content - ingestOrder's update path); a
 * `cancelled` event, or an order that now reads cancelled, cancels. An id
 * ezCater no longer knows is ignored with the reason, never guessed at.
 */
export function ezCaterAction(event: EzCaterOrderEvent, order: EzCaterOrder | null): EzCaterAction {
  if (event.type === "cancelled" || order?.status === "cancelled") return { kind: "cancel", orderId: event.orderId };
  if (!order) return { kind: "ignore", reason: `ezCater has no order ${event.orderId}` };
  if (order.orderId !== event.orderId) return { kind: "ignore", reason: `fetched ${order.orderId} for event ${event.orderId}` };
  return { kind: "upsert", order };
}

/** The canonical order for ezCater, with its own source until orders.source allows 'ezcater' (see the header). */
export type EzCaterCanonicalOrder = Omit<CanonicalOrderInput, "source"> & { source: "ezcater" };

const dollars = (n: number) => `$${n.toFixed(2)}`;
const zeroNull = (n: number | null) => (n === null || n === 0 ? null : n);

/**
 * Map to the shape every source produces. Items print like a Zuppler or
 * phone order's (quantity folded into the name, the line's extended price);
 * the address keeps the "street | instructions" convention the ticket
 * renderer prints as a driver line; headcount and notes go in the NOTE box,
 * because a kitchen making a catering order needs the headcount first.
 * `paymentType` says prepaid: ezCater collects from the customer and pays
 * PFD, so nothing is due at the door.
 */
export function ezCaterOrderToCanonical(order: EzCaterOrder, restaurant: { id: string; name: string | null }): EzCaterCanonicalOrder {
  const items = order.items.map((it) => {
    const modifiers = [...it.modifiers];
    if (it.specialInstructions) modifiers.push(it.specialInstructions);
    return {
      name: it.quantity > 1 ? `${it.quantity}x ${it.name}` : it.name,
      price: it.total === null ? null : dollars(it.total),
      modifiers,
    };
  });
  const a = order.deliveryAddress;
  const street = a ? [a.street, [a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(", ") : "";
  const address = order.fulfillment === "delivery" ? [street || null, a?.instructions ?? null].filter(Boolean).join(" | ") || null : null;
  const notes = [order.headcount ? `Headcount: ${order.headcount}` : null, order.notes].filter(Boolean).join("\n") || null;
  const m = order.money;

  return {
    source: "ezcater",
    externalId: order.orderId,
    restaurantId: restaurant.id,
    orderNumber: order.orderNumber,
    ticketRestaurantName: restaurant.name,
    receivedAt: order.placedAt,
    orderType: order.fulfillment === "delivery" ? "delivery" : "pickup",
    dueTime: order.eventTime,
    customerName: order.contact.name,
    customerPhone: order.contact.phone,
    customerAddress: address,
    items,
    itemsTotal: m.subtotal,
    tax: m.tax,
    deliveryFee: zeroNull(m.deliveryFee),
    tip: zeroNull(m.tip),
    customerTotal: m.total,
    paymentType: "ezCater (prepaid)",
    notes,
    rawPayload: { kind: "ezcater_order", order },
  };
}

/** For tests and a dry run: events you push, orders you set. Never talks to ezCater. */
export class FakeEzCaterProvider implements EzCaterProvider {
  private handlers: ((e: EzCaterOrderEvent) => Promise<void> | void)[] = [];
  readonly orders = new Map<string, EzCaterOrder>();

  async subscribe(onEvent: (e: EzCaterOrderEvent) => Promise<void> | void) {
    this.handlers.push(onEvent);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== onEvent);
    };
  }

  async fetchOrder(orderId: string) {
    return this.orders.get(orderId) ?? null;
  }

  async emit(event: EzCaterOrderEvent) {
    for (const h of this.handlers) await h(event);
  }
}
