import { supabaseAdmin } from "./supabase-server";
import { notifyRestaurant } from "./push";
import { resolveFooter } from "./footer-engine";

/**
 * The canonical order: the single contract every ingestion source must
 * produce. The email parser and the Zuppler webhook both map into this,
 * and everything downstream (dashboard, push, printing) only ever sees
 * this shape. Adding a new order source = writing one mapper to this type.
 */
export interface CanonicalOrderInput {
  /** "test" is a real source in the database (migration 006) - a CRM-issued
   *  test print. It never reaches ingestOrder today, since test prints insert
   *  directly, but the type should not claim otherwise. */
  source: "email" | "zuppler" | "test";
  /** The source system's own id (Gmail message id, Zuppler order uuid). */
  externalId: string;
  restaurantId: string;
  /** Monitored inbox the order came from - email source only. */
  inboxId?: string | null;

  orderNumber: string;
  ticketRestaurantName?: string | null;
  /**
   * When the ORDER was placed, per the source system. Omit and the row falls
   * back to now(). Without this a replayed or backfilled order looks like it
   * arrived when we happened to ingest it - which on a ticket reads as a due
   * time before the order existed.
   */
  receivedAt?: string | null;
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
  /** Promotional discount. Reduces the total; not part of the component sum. */
  discount?: number | null;
  /** Tax already inside subtotal. Recorded, never added when reconciling. */
  includedTax?: number | null;
  /** Zuppler's "hidden" total. Zero everywhere so far; captured regardless. */
  hiddenFee?: number | null;
  /** Zuppler channel the order arrived on - accounting groups by this. */
  channelId?: string | null;
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
  "delivery_fee", "tip", "discount", "included_tax", "hidden_fee",
  "customer_total", "payment_type", "notes",
] as const;

/**
 * total - (subtotal + tax + service + delivery + tip - discount)
 *
 * Zero when every money field is captured. Anything else means one is not -
 * and the whole reason this is computed at ingest rather than in a report is
 * that a report is written months later by someone who assumes the columns
 * are complete.
 *
 * includedTax is deliberately excluded: it is tax already inside subtotal, so
 * adding it would double-count. hidden is excluded for the same reason until
 * an order appears where it is non-zero and its meaning can be established.
 */
export function moneyVariance(input: {
  itemsTotal?: number | null; tax?: number | null; serviceFee?: number | null;
  deliveryFee?: number | null; tip?: number | null; discount?: number | null;
  customerTotal?: number | null;
}): number | null {
  if (input.customerTotal == null) return null;
  const n = (v: unknown) => Number(v ?? 0);
  const components =
    n(input.itemsTotal) + n(input.tax) + n(input.serviceFee) +
    n(input.deliveryFee) + n(input.tip) - n(input.discount);
  return Math.round((Number(input.customerTotal) - components) * 100) / 100;
}

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
    if (["items_total", "tax", "service_fee", "delivery_fee", "tip", "discount",
         "included_tax", "hidden_fee", "customer_total"].includes(key)) {
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
      discount: input.discount ?? null,
      included_tax: input.includedTax ?? null,
      hidden_fee: input.hiddenFee ?? null,
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
      .update({
        ...changes,
        // An amended order changes the arithmetic, so the tripwire is
        // recomputed rather than left describing the original figures.
        money_variance: moneyVariance(input),
        raw_payload: input.rawPayload ?? null,
      })
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

  // A ticket with no restaurant name on it prints as "PFD ORDER", which tells
  // the kitchen nothing. The parser can miss the header (formats change), so
  // fall back to the restaurant we already know this order belongs to. Doing
  // it here covers every source rather than each caller remembering.
  let ticketName = input.ticketRestaurantName ?? null;
  if (!ticketName) {
    const { data: restaurant } = await admin
      .from("restaurants")
      .select("name")
      .eq("id", input.restaurantId)
      .maybeSingle();
    ticketName = restaurant?.name ?? null;
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
      ticket_restaurant_name: ticketName,
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
      discount: input.discount ?? null,
      included_tax: input.includedTax ?? null,
      hidden_fee: input.hiddenFee ?? null,
      channel_id: input.channelId ?? null,
      customer_total: input.customerTotal ?? null,
      money_variance: moneyVariance(input),
      payment_type: input.paymentType ?? null,
      notes: input.notes ?? null,
      raw_html: input.rawHtml ?? null,
      raw_payload: input.rawPayload ?? null,
      // Only override the now() default when the source actually told us.
      ...(input.receivedAt ? { received_at: input.receivedAt } : {}),
      status: "new",
    })
    .select()
    .single();

  if (insertError) {
    // Unique-index race (two pollers/webhook retries): treat as duplicate
    if (insertError.code === "23505") return { status: "duplicate" };
    return { status: "error", error: insertError.message };
  }

  // --- Resolve this order's footer, ONCE, here ---
  // At ingest rather than at print: printing must not run queries while a
  // cook waits, and a reprint has to say what the customer is holding.
  // Test orders are excluded - a test print should not mint a coupon or burn
  // a token.
  if (input.source !== "test") {
    const { data: restaurantRow } = await admin
      .from("restaurants")
      .select("id, footer_engine, footer_template_id, footer_template_config, ticket_footer_url")
      .eq("id", input.restaurantId)
      .maybeSingle();
    if (restaurantRow?.footer_engine === "dynamic") {
      const resolved = await resolveFooter(restaurantRow, {
        restaurantId: input.restaurantId,
        orderId: inserted.id,
        customerName: input.customerName,
      });
      if (resolved) {
        await admin
          .from("orders")
          .update({ footer_resolved: resolved })
          .eq("id", inserted.id);
      }
    }
  }

  // --- Notify dashboard users (existing web push) ---
  await notifyRestaurant(input.restaurantId, {
    title: `New Order #${input.orderNumber}`,
    body: input.customerTotal
      ? `${input.customerName || "Customer"} - $${input.customerTotal.toFixed(2)}`
      : "Tap to view the order",
    orderId: inserted.id,
  });

  // --- Deliver the ticket: printer or email ---
  // Branch on the restaurant's print_method. An email restaurant gets exactly
  // ONE print_jobs row with delivery='email' and no device - print_jobs stays
  // the single record of "a ticket was meant to reach this restaurant", so
  // the monitor and the Printers console keep working on one shape.
  const { data: deliveryRow } = await admin
    .from("restaurants")
    .select("print_method, ticket_email_to, ticket_footer_text, ticket_footer_url, ticket_text_scale")
    .eq("id", input.restaurantId)
    .maybeSingle();

  if (deliveryRow?.print_method === "email") {
    await deliverByEmail({
      orderId: inserted.id,
      restaurant: deliveryRow,
      order: inserted,
    });
  } else {
    // Unchanged: one job per active device.
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
  }

  return { status: "created", orderId: inserted.id };
}

/**
 * Emails the ticket for one order, recording the attempt on a print_jobs row.
 *
 * The row is written BEFORE the send, so a crash mid-send leaves evidence
 * that a ticket was owed rather than nothing at all - the monitor then
 * reports an email job with no sent_at, which is exactly the condition worth
 * knowing about.
 *
 * Never throws. A restaurant that cannot be emailed is a serious problem, but
 * it is not a reason to fail an order that has otherwise been ingested
 * correctly - the order still reaches the dashboard, and the monitor raises
 * the failure.
 */
async function deliverByEmail(args: {
  orderId: string;
  restaurant: {
    ticket_email_to?: string | null;
    ticket_footer_text?: string | null;
    ticket_footer_url?: string | null;
    ticket_text_scale?: string | null;
  };
  order: Record<string, any>;
}): Promise<void> {
  const admin = supabaseAdmin();
  const to = (args.restaurant.ticket_email_to ?? "").trim();

  const { data: job, error: jobError } = await admin
    .from("print_jobs")
    .insert({ order_id: args.orderId, device_id: null, delivery: "email" })
    .select("id")
    .single();

  if (jobError) {
    // 23505 = the partial unique index; this order already has an email job,
    // which is the idempotency guarantee doing its work on a retried webhook.
    if (jobError.code === "23505") return;
    console.error("email delivery: could not record job", jobError.message);
    return;
  }

  if (!to) {
    const err = "print_method is 'email' but ticket_email_to is empty";
    console.error("email delivery:", err, "order", args.orderId);
    await admin.from("print_jobs")
      .update({ status: "failed", send_error: err, finished_at: new Date().toISOString() })
      .eq("id", job.id);
    return;
  }

  const { composeTicketEmail, sendTicketEmail } = await import("./email-out");
  const email = composeTicketEmail(args.order as any, {
    footer: {
      text: args.restaurant.ticket_footer_text,
      url: args.restaurant.ticket_footer_url,
    },
  });

  const result = await sendTicketEmail(to, email);
  const now = new Date().toISOString();

  if (result.ok) {
    await admin.from("print_jobs")
      .update({ status: "printed", sent_at: now, finished_at: now })
      .eq("id", job.id);
    await admin.from("orders")
      .update({ status: "printed", printed_at: now })
      .eq("id", args.orderId);
  } else {
    console.error("email delivery FAILED for order", args.orderId, "-", result.error);
    await admin.from("print_jobs")
      .update({ status: "failed", send_error: result.error ?? "unknown", finished_at: now })
      .eq("id", job.id);
  }
}

/** Sends the cancellation notice for an email-delivery restaurant. */
export async function sendCancellationEmail(orderId: string): Promise<void> {
  const admin = supabaseAdmin();
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, customer_name, customer_total, restaurant_id, restaurants(print_method, ticket_email_to)")
    .eq("id", orderId)
    .maybeSingle();
  const r = (order as any)?.restaurants;
  if (!order || r?.print_method !== "email" || !r?.ticket_email_to) return;

  const { composeCancellationEmail, sendTicketEmail } = await import("./email-out");
  const result = await sendTicketEmail(r.ticket_email_to, composeCancellationEmail(order as any));
  if (!result.ok) {
    console.error("cancellation email FAILED for order", orderId, "-", result.error);
  }
}
