import { supabaseAdmin } from "./supabase-server";
import { notifyRestaurant } from "./push";

/**
 * The canonical order: the single contract every ingestion source must
 * produce. The email parser and the Zuppler webhook both map into this,
 * and everything downstream (dashboard, push, printing) only ever sees
 * this shape. Adding a new order source = writing one mapper to this type.
 */
export interface CanonicalOrderInput {
  source: "email" | "zuppler";
  /** The source system's own id (Gmail message id, Zuppler order uuid). */
  externalId: string;
  restaurantId: string;
  /** Monitored inbox the order came from - email source only. */
  inboxId?: string | null;

  orderNumber: string;
  ticketRestaurantName?: string | null;
  orderType?: "pickup" | "delivery" | null;
  dueTime?: string | null; // ISO timestamp
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  items: { name: string; price: string | null; modifiers: string[] }[];
  itemsTotal?: number | null;
  tax?: number | null;
  serviceFee?: number | null;
  /** Delivery charge, separate from serviceFee. */
  deliveryFee?: number | null;
  /** Customer tip - the driver's money. Printed on the ticket. */
  tip?: number | null;
  customerTotal?: number | null;
  paymentType?: string | null;
  /** Free-text order/customer notes - printed in the ticket NOTE box. */
  notes?: string | null;

  /** Original HTML email body - email source only. */
  rawHtml?: string | null;
  /** Original webhook/API payload - API sources only. */
  rawPayload?: unknown;
}

export interface IngestResult {
  status: "created" | "duplicate" | "updated" | "error";
  orderId?: string;
  error?: string;
}

/** Fields an upstream source may legitimately revise after an order exists. */
const MUTABLE_FIELDS = [
  "order_type", "due_time", "customer_name", "customer_phone",
  "customer_address", "items", "items_total", "tax", "service_fee",
  "delivery_fee", "tip", "customer_total", "payment_type", "notes",
] as const;

const sameMoney = (a: unknown, b: unknown) => {
  const na = a == null ? null : Number(a);
  const nb = b == null ? null : Number(b);
  if (na == null || nb == null) return na === nb;
  return Math.abs(na - nb) < 0.005;
};

/**
 * Diffs an existing order against a freshly mapped one.
 *
 * Zuppler amends orders after the fact - a tip going from $0.00 to $11.37 is
 * a real example, and that is the driver's money. Treating the second webhook
 * purely as a duplicate silently keeps the stale figures, so reconciliation
 * and the dashboard would disagree with what the customer was charged.
 *
 * Returns only the columns that actually changed, or null when nothing did,
 * so an unchanged re-delivery stays a cheap no-op.
 */
export function orderUpdateFields(
  existing: Record<string, any>,
  next: Record<string, any>
): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  for (const key of MUTABLE_FIELDS) {
    if (!(key in next)) continue;
    const to = next[key];
    // Never overwrite real data with nothing - a sparser re-delivery should
    // not erase an address or an itemisation we already have.
    if (to == null || to === "") continue;
    const from = existing[key];

    if (key === "items") {
      if (JSON.stringify(from ?? []) !== JSON.stringify(to)) changes[key] = to;
      continue;
    }
    if (["items_total", "tax", "service_fee", "delivery_fee", "tip", "customer_total"].includes(key)) {
      if (!sameMoney(from, to)) changes[key] = to;
      continue;
    }
    if (key === "due_time") {
      const a = from ? new Date(from).getTime() : null;
      const b = to ? new Date(to).getTime() : null;
      if (a !== b) changes[key] = to;
      continue;
    }
    if (String(from ?? "") !== String(to)) changes[key] = to;
  }
  return Object.keys(changes).length ? changes : null;
}

/**
 * Single write path for orders from ANY source.
 * De-duplicates, inserts, sends push, and queues print jobs for every
 * active print device at the restaurant.
 */
export async function ingestOrder(
  input: CanonicalOrderInput
): Promise<IngestResult> {
  const admin = supabaseAdmin();

  // --- Dedupe 1: same source, same external id ---
  const { data: existing } = await admin
    .from("orders")
    // One literal string: concatenation defeats supabase-js's type inference.
    .select("id, order_type, due_time, customer_name, customer_phone, customer_address, items, items_total, tax, service_fee, delivery_fee, tip, customer_total, payment_type, notes")
    .eq("source", input.source)
    .eq("external_id", input.externalId)
    .maybeSingle();

  if (existing) {
    // Email is immutable - a message never changes once sent, so a repeat is
    // simply a repeat. API sources amend orders, and those revisions matter.
    if (input.source !== "zuppler") {
      return { status: "duplicate", orderId: existing.id };
    }

    const next = {
      order_type: input.orderType ?? null,
      due_time: input.dueTime ?? null,
      customer_name: input.customerName ?? null,
      customer_phone: input.customerPhone ?? null,
      customer_address: input.customerAddress ?? null,
      items: input.items,
      items_total: input.itemsTotal ?? null,
      tax: input.tax ?? null,
      service_fee: input.serviceFee ?? null,
      delivery_fee: input.deliveryFee ?? null,
      tip: input.tip ?? null,
      customer_total: input.customerTotal ?? null,
      payment_type: input.paymentType ?? null,
      notes: input.notes ?? null,
    };

    const changes = orderUpdateFields(existing, next);
    if (!changes) return { status: "duplicate", orderId: existing.id };

    console.log("Zuppler order adjusted", {
      orderId: existing.id,
      externalId: input.externalId,
      changed: Object.keys(changes),
      totalFrom: existing.customer_total,
      totalTo: next.customer_total,
    });

    const { error: updateError } = await admin
      .from("orders")
      .update({ ...changes, raw_payload: input.rawPayload ?? null })
      .eq("id", existing.id);

    if (updateError) return { status: "error", error: updateError.message };

    // Deliberately NOT re-queuing a print job. The kitchen ticket is already
    // out, and a second one risks the food being made twice - a far worse
    // failure than a stale figure on paper. The dashboard now shows the
    // corrected money, which is what reconciliation and driver payout use.
    return { status: "updated", orderId: existing.id };
  }

  // --- Dedupe 2 (cross-source): same restaurant + order number arriving via
  // a DIFFERENT source within the last day. Protects against double prints
  // while both the webhook and the order email are live for a restaurant. ---
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: crossDupe } = await admin
    .from("orders")
    .select("id, source")
    .eq("restaurant_id", input.restaurantId)
    .eq("order_number", input.orderNumber)
    .gte("received_at", oneDayAgo)
    .maybeSingle();
  if (crossDupe && crossDupe.source !== input.source) {
    return { status: "duplicate", orderId: crossDupe.id };
  }

  const { data: inserted, error: insertError } = await admin
    .from("orders")
    .insert({
      source: input.source,
      external_id: input.externalId,
      restaurant_id: input.restaurantId,
      inbox_id: input.inboxId ?? null,
      gmail_message_id: input.source === "email" ? input.externalId : null,
      order_number: input.orderNumber,
      ticket_restaurant_name: input.ticketRestaurantName ?? null,
      order_type: input.orderType ?? null,
      due_time: input.dueTime ?? null,
      customer_name: input.customerName ?? null,
      customer_phone: input.customerPhone ?? null,
      customer_address: input.customerAddress ?? null,
      items: input.items,
      items_total: input.itemsTotal ?? null,
      tax: input.tax ?? null,
      service_fee: input.serviceFee ?? null,
      delivery_fee: input.deliveryFee ?? null,
      tip: input.tip ?? null,
      customer_total: input.customerTotal ?? null,
      payment_type: input.paymentType ?? null,
      notes: input.notes ?? null,
      raw_html: input.rawHtml ?? null,
      raw_payload: input.rawPayload ?? null,
      status: "new",
    })
    .select()
    .single();

  if (insertError) {
    // Unique-index race (two pollers/webhook retries): treat as duplicate
    if (insertError.code === "23505") return { status: "duplicate" };
    return { status: "error", error: insertError.message };
  }

  // --- Notify dashboard users (existing web push) ---
  await notifyRestaurant(input.restaurantId, {
    title: `New Order #${input.orderNumber}`,
    body: input.customerTotal
      ? `${input.customerName || "Customer"} - $${input.customerTotal.toFixed(2)}`
      : "Tap to view the order",
    orderId: inserted.id,
  });

  // --- Queue a print job for every active device at this restaurant ---
  const { data: devices } = await admin
    .from("print_devices")
    .select("id")
    .eq("restaurant_id", input.restaurantId)
    .eq("is_active", true);

  if (devices?.length) {
    await admin.from("print_jobs").insert(
      devices.map((d) => ({ order_id: inserted.id, device_id: d.id }))
    );
  }

  return { status: "created", orderId: inserted.id };
}
