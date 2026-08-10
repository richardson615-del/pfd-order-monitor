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
  status: "created" | "duplicate" | "error";
  orderId?: string;
  error?: string;
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
    .select("id")
    .eq("source", input.source)
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (existing) return { status: "duplicate", orderId: existing.id };

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
