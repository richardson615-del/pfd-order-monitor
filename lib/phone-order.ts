import { createHash } from "node:crypto";
import type { CanonicalOrderInput } from "./canonical";
import { TENDER_LINE_RE } from "./ticket";

/**
 * Phone orders taken in the CRM (Workstream O1, Nick 2026-09-18).
 *
 * A dispatcher answers the phone, builds the order in the CRM and charges
 * the card there; the CRM then POSTs it to /api/crm/orders. This module is
 * the pure half of that route: what a valid body looks like, how it becomes
 * a canonical order, what the ticket says about the money, and how a retry
 * is told apart from a different order wearing the same id.
 *
 * The order reaches the restaurant exactly as a Zuppler order does - the
 * mapping below produces a CanonicalOrderInput and ingestOrder() does the
 * rest - so nothing about printing, the tablet or orders.status is
 * repeated here. Adding a source is writing one mapper (lib/canonical.ts).
 *
 * Validation is a hand-written parser rather than a schema library because
 * that is how every other CRM-facing body is checked in this repo
 * (lib/device-binding.ts parseBindings); the brief's "zod" is a shape, not
 * a dependency to add.
 */

export const PHONE_ORDER_TYPES = ["delivery", "pickup"] as const;
export const PHONE_PAYMENT_TYPES = ["cash", "card", "house"] as const;
export const PHONE_PAYMENT_STATUSES = ["paid", "due"] as const;

export type PhoneOrderType = (typeof PHONE_ORDER_TYPES)[number];
export type PhonePaymentType = (typeof PHONE_PAYMENT_TYPES)[number];
export type PhonePaymentStatus = (typeof PHONE_PAYMENT_STATUSES)[number];

export interface PhoneOrderModifier {
  name: string;
  /** Dollars per unit of the item; 0 for a free choice. */
  price: number;
}

export interface PhoneOrderItem {
  name: string;
  /** Unit price in dollars, before modifiers. */
  price: number;
  qty: number;
  modifiers: PhoneOrderModifier[];
  notes: string | null;
}

export interface PhoneOrderMoney {
  subtotal: number;
  tax: number;
  delivery_fee: number;
  service_fee: number;
  tip: number;
  discount: number;
  /** Card surcharge - PFD's line, not the restaurant's (migration 042). */
  surcharge: number;
  total: number;
}

export interface PhoneOrderPayment {
  type: PhonePaymentType;
  status: PhonePaymentStatus;
  /** The card's last four digits, and never more than four. */
  last4: string | null;
}

/** The body of POST /api/crm/orders, after parsing. */
export interface PhoneOrder {
  /** Either id, as the CRM sent it; the route resolves it (lib/restaurant-ref.ts). */
  restaurant_ref: string;
  external_id: string;
  /** What the ticket says; `P-` + the tail of external_id unless the CRM chose one. */
  order_number: string;
  order_type: PhoneOrderType;
  /** ISO instant, or null for ASAP. */
  due_time: string | null;
  customer: {
    name: string;
    phone: string | null;
    address: string | null;
    address2: string | null;
    notes: string | null;
  };
  items: PhoneOrderItem[];
  money: PhoneOrderMoney;
  payment: PhoneOrderPayment;
  notes: string | null;
  actor: string | null;
}

/**
 * Both members carry every key: this project compiles with strict:false,
 * where narrowing on the literal `ok` is unreliable (lib/restaurant-resolve.ts
 * made the same choice). `order` is present exactly when `ok` is true.
 */
export type PhoneOrderParse =
  | { ok: true; order: PhoneOrder; error?: undefined; code?: undefined }
  | { ok: false; order?: undefined; error: string; code: string };

/** Bounds a phone order cannot sensibly exceed; anything past them is a bug upstream, not an order. */
export const PHONE_ORDER_MAX_ITEMS = 200;
export const PHONE_ORDER_MAX_QTY = 99;
export const PHONE_ORDER_MAX_TOTAL = 5000;

const EXTERNAL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ORDER_NUMBER_RE = /^[A-Za-z0-9-]{1,20}$/;
const LAST4_RE = /^\d{4}$/;
/** 13 to 19 digits in a row, with or without the spaces or dashes people type between groups. */
const PAN_RE = /(?:\d[ -]?){12,18}\d/;

/**
 * Does this text look like a card number? A run of 13-19 digits, allowing
 * the spaces or dashes people put between groups. A phone number is 10 or
 * 11 digits and passes; the kind of thing that must never reach a ticket, a
 * database column or a log does not. Every free-text field is checked.
 */
export function looksLikeCardNumber(text: unknown): boolean {
  return typeof text === "string" && PAN_RE.test(text);
}

const fail = (code: string, error: string): PhoneOrderParse => ({ ok: false, error, code });

const optStr = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

/** A non-negative dollar amount with at most cents of precision; null when not one. */
const cents = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
};

/** `P-` and the last six characters of the id, upper-cased - short enough for a ticket, unique enough for a day. */
export function defaultOrderNumber(externalId: string): string {
  const tail = externalId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  return `P-${tail || "ORDER"}`;
}

/**
 * Parses a request body into a PhoneOrder, or says what is wrong with it.
 *
 * Every rejection names a field, because the caller is the CRM's order
 * builder and "bad request" would send a dispatcher back to the customer
 * with nothing to say.
 */
export function parsePhoneOrder(body: unknown): PhoneOrderParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("invalid_body", "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  if (b.source !== "phone") return fail("invalid_source", "source must be 'phone'");

  const ref = optStr(b.restaurant_id, 128) ?? optStr(b.crm_restaurant_id, 128);
  if (!ref) return fail("restaurant_required", "restaurant_id (either id) is required");

  const externalId = typeof b.external_id === "string" ? b.external_id.trim() : null;
  if (!externalId || !EXTERNAL_ID_RE.test(externalId)) {
    return fail("external_id_required", "external_id is required: the CRM's phone order id, 1-128 chars of [A-Za-z0-9._:-]");
  }

  let orderNumber = optStr(b.order_number, 20);
  if (orderNumber && !ORDER_NUMBER_RE.test(orderNumber)) {
    return fail("invalid_order_number", "order_number may only be 1-20 letters, digits or dashes");
  }
  if (!orderNumber) orderNumber = defaultOrderNumber(externalId);

  const orderType = b.order_type;
  if (!PHONE_ORDER_TYPES.includes(orderType as PhoneOrderType)) {
    return fail("invalid_order_type", "order_type must be 'delivery' or 'pickup'");
  }

  let dueTime: string | null = null;
  if (b.due_time != null) {
    const t = typeof b.due_time === "string" ? Date.parse(b.due_time) : NaN;
    if (Number.isNaN(t)) return fail("invalid_due_time", "due_time must be an ISO timestamp or null for ASAP");
    dueTime = new Date(t).toISOString();
  }

  const c = b.customer;
  if (!c || typeof c !== "object" || Array.isArray(c)) return fail("customer_required", "customer is required");
  const cu = c as Record<string, unknown>;
  const customerName = optStr(cu.name, 120);
  if (!customerName) return fail("customer_name_required", "customer.name is required");
  const customer = {
    name: customerName,
    phone: optStr(cu.phone, 40),
    address: optStr(cu.address, 240),
    address2: optStr(cu.address2, 120),
    notes: optStr(cu.notes, 500),
  };
  if (orderType === "delivery" && !customer.address) {
    return fail("address_required", "customer.address is required for a delivery order");
  }

  if (!Array.isArray(b.items) || b.items.length === 0) return fail("items_required", "items must be a non-empty array");
  if (b.items.length > PHONE_ORDER_MAX_ITEMS) return fail("too_many_items", `at most ${PHONE_ORDER_MAX_ITEMS} items`);
  const items: PhoneOrderItem[] = [];
  for (let i = 0; i < b.items.length; i++) {
    const raw = b.items[i];
    if (!raw || typeof raw !== "object") return fail("invalid_item", `items[${i}] must be an object`);
    const it = raw as Record<string, unknown>;
    const name = optStr(it.name, 200);
    if (!name) return fail("invalid_item", `items[${i}].name is required`);
    const price = cents(it.price);
    if (price === null) return fail("invalid_item", `items[${i}].price must be a non-negative number of dollars`);
    const qtyRaw = it.qty == null ? 1 : it.qty;
    const qty = typeof qtyRaw === "number" && Number.isInteger(qtyRaw) ? qtyRaw : NaN;
    if (!(qty >= 1 && qty <= PHONE_ORDER_MAX_QTY)) return fail("invalid_item", `items[${i}].qty must be an integer 1-${PHONE_ORDER_MAX_QTY}`);
    const modifiers: PhoneOrderModifier[] = [];
    const mods = it.modifiers == null ? [] : it.modifiers;
    if (!Array.isArray(mods)) return fail("invalid_item", `items[${i}].modifiers must be an array`);
    for (let j = 0; j < mods.length; j++) {
      const m = mods[j] as Record<string, unknown>;
      const mName = m && typeof m === "object" ? optStr(m.name, 200) : null;
      if (!mName) return fail("invalid_item", `items[${i}].modifiers[${j}].name is required`);
      const mPrice = m.price == null ? 0 : cents(m.price);
      if (mPrice === null) return fail("invalid_item", `items[${i}].modifiers[${j}].price must be a non-negative number of dollars`);
      modifiers.push({ name: mName, price: mPrice });
    }
    items.push({ name, price, qty, modifiers, notes: optStr(it.notes, 300) });
  }

  const m = b.money;
  if (!m || typeof m !== "object" || Array.isArray(m)) return fail("money_required", "money is required");
  const mo = m as Record<string, unknown>;
  const total = cents(mo.total);
  if (total === null) return fail("invalid_money", "money.total must be a non-negative number of dollars");
  if (total > PHONE_ORDER_MAX_TOTAL) return fail("invalid_money", `money.total exceeds $${PHONE_ORDER_MAX_TOTAL}`);
  const part = (key: keyof PhoneOrderMoney): number | null => (mo[key] == null ? 0 : cents(mo[key]));
  const money: Partial<PhoneOrderMoney> = { total };
  for (const key of ["subtotal", "tax", "delivery_fee", "service_fee", "tip", "discount", "surcharge"] as const) {
    const v = part(key);
    if (v === null) return fail("invalid_money", `money.${key} must be a non-negative number of dollars`);
    money[key] = v;
  }
  const mm = money as PhoneOrderMoney;
  // The same arithmetic ingest records as money_variance. An order that does
  // not add up is refused here rather than stored as unreconciled: the CRM
  // computed these figures a moment ago and can fix them; a statement three
  // months from now cannot.
  const variance = Math.round((mm.total - (mm.subtotal + mm.tax + mm.delivery_fee + mm.service_fee + mm.tip + mm.surcharge - mm.discount)) * 100) / 100;
  if (variance !== 0) {
    return fail("money_mismatch", `money.total ($${mm.total.toFixed(2)}) does not equal subtotal + tax + delivery_fee + service_fee + tip + surcharge - discount (off by $${variance.toFixed(2)})`);
  }

  const p = b.payment;
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail("payment_required", "payment is required");
  const pa = p as Record<string, unknown>;
  if (!PHONE_PAYMENT_TYPES.includes(pa.type as PhonePaymentType)) return fail("invalid_payment", "payment.type must be 'cash', 'card' or 'house'");
  if (!PHONE_PAYMENT_STATUSES.includes(pa.status as PhonePaymentStatus)) return fail("invalid_payment", "payment.status must be 'paid' or 'due'");
  let last4: string | null = null;
  if (pa.last4 != null) {
    const s = String(pa.last4).trim();
    // Exactly four. Anything longer is a card number arriving where only its
    // tail belongs, and is refused rather than truncated so the caller finds
    // out - truncating would hide that a PAN was ever sent.
    if (!LAST4_RE.test(s)) return fail("invalid_payment", "payment.last4 must be exactly four digits");
    last4 = s;
  }
  const payment: PhoneOrderPayment = { type: pa.type as PhonePaymentType, status: pa.status as PhonePaymentStatus, last4 };

  const notes = optStr(b.notes, 1000);
  const actor = optStr(b.actor, 200);

  // No card number anywhere. Checked last, over every free-text field, so a
  // PAN typed into a notes box by mistake never reaches a ticket or a column.
  const texts = [customer.name, customer.phone, customer.address, customer.address2, customer.notes, notes, actor, orderNumber,
    ...items.flatMap((it) => [it.name, it.notes, ...it.modifiers.map((x) => x.name)])];
  if (texts.some(looksLikeCardNumber)) {
    return fail("card_number_rejected", "a field contains what looks like a card number; only payment.last4 may carry card digits");
  }

  return {
    ok: true,
    order: {
      restaurant_ref: ref,
      external_id: externalId,
      order_number: orderNumber,
      order_type: orderType as PhoneOrderType,
      due_time: dueTime,
      customer,
      items,
      money: mm,
      payment,
      notes,
      actor,
    },
  };
}

/**
 * What the ticket says about the money, in a form a cook can act on:
 * "PAID - CARD ****1234" means hand it over; "CASH DUE $42.10" means
 * collect. Never the word Zuppler, and never a bare tender name - a
 * restaurant reading "CASH" cannot tell whether it was already taken.
 *
 * ASCII only. This string goes to an Epson through ePOS-Print text, where
 * a bullet or an em dash is a code-page gamble; "****" and "-" print
 * everywhere. Every value matches TENDER_LINE_RE, which is how the ticket
 * renderer knows to print it as an instruction (asserted in the tests).
 */
export function tenderLine(payment: PhoneOrderPayment, total: number): string {
  const due = `$${total.toFixed(2)}`;
  switch (payment.type) {
    case "card": {
      const card = payment.last4 ? `CARD ****${payment.last4}` : "CARD";
      return payment.status === "paid" ? `PAID - ${card}` : `CARD DUE ${due} (${card})`;
    }
    case "cash":
      return payment.status === "paid" ? "PAID - CASH" : `CASH DUE ${due}`;
    case "house":
      return payment.status === "paid" ? "PAID - HOUSE ACCOUNT" : "HOUSE ACCOUNT - DO NOT COLLECT";
  }
}

/** Dollars as the ticket prints them. */
const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * The canonical order for a phone order.
 *
 * Items take the shape the ticket renderer already understands (quantity
 * folded into the name, one string per modifier, the line's extended price)
 * so the paper and the tablet show a phone order exactly as they show a
 * Zuppler one. The address keeps the mapper's "street | instructions"
 * convention: the renderer prints everything after the first pipe as a
 * ">> " instruction line for the driver.
 */
export function phoneOrderToCanonical(
  order: PhoneOrder,
  restaurant: { id: string; name: string | null },
  opts: { fingerprint: string; receivedAt?: string }
): CanonicalOrderInput {
  const items = order.items.map((it) => {
    const unit = it.price + it.modifiers.reduce((s, m) => s + m.price, 0);
    const line = Math.round(unit * it.qty * 100) / 100;
    const modifiers = it.modifiers.map((m) => (m.price ? `${m.name} +${dollars(m.price)}` : m.name));
    if (it.notes) modifiers.push(it.notes);
    return {
      name: it.qty > 1 ? `${it.qty}x ${it.name}` : it.name,
      price: dollars(line),
      modifiers,
    };
  });

  const street = [order.customer.address, order.customer.address2].filter(Boolean).join(", ");
  const address = [street || null, order.customer.notes].filter(Boolean).join(" | ") || null;
  const m = order.money;
  const zeroNull = (n: number) => (n === 0 ? null : n);

  return {
    source: "phone",
    externalId: order.external_id,
    restaurantId: restaurant.id,
    orderNumber: order.order_number,
    ticketRestaurantName: restaurant.name,
    receivedAt: opts.receivedAt ?? null,
    orderType: order.order_type,
    dueTime: order.due_time,
    customerName: order.customer.name,
    customerPhone: order.customer.phone,
    customerAddress: address,
    items,
    itemsTotal: m.subtotal,
    tax: m.tax,
    serviceFee: zeroNull(m.service_fee),
    deliveryFee: zeroNull(m.delivery_fee),
    tip: m.tip,
    discount: zeroNull(m.discount),
    surcharge: zeroNull(m.surcharge),
    customerTotal: m.total,
    paymentType: tenderLine(order.payment, m.total),
    notes: order.notes,
    rawPayload: {
      kind: "phone_order",
      fingerprint: opts.fingerprint,
      actor: order.actor,
      order: { ...order, actor: undefined },
    },
  };
}

/**
 * One hash for "the same order". A retry of the same phone_orders id with
 * the same content is idempotent (200, the existing row); the same id with
 * different content is refused (409) - an id is not allowed to mean two
 * orders, and the kitchen already has the first one. `actor` is left out:
 * who pressed retry is not part of what was ordered.
 */
export function phoneOrderFingerprint(order: PhoneOrder): string {
  const { actor: _actor, ...rest } = order;
  return createHash("sha256").update(stableJson(rest)).digest("hex");
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The fingerprint an existing row was stored with, or null when it was not a phone order of this shape. */
export function storedFingerprint(rawPayload: unknown): string | null {
  const p = rawPayload as any;
  return p && typeof p === "object" && p.kind === "phone_order" && typeof p.fingerprint === "string" ? p.fingerprint : null;
}
