import { supabaseAdmin } from "./supabase-server";
import { appDeliveryOutcome, orderDestinations, type OrderDestination } from "./canonical";
import { queueOrderToPrinters } from "./print-queue";
import { resendBy } from "./print-policy";
import { notifyRestaurant } from "./push";
import { resentBanner } from "./crm-orders";

/**
 * RESEND from the CRM's Orders area (Nick, 2026-09-29): "we should be able
 * to resend any order that restaurant received in the past day". One press
 * sends the order everywhere the restaurant receives orders NOW - its
 * printers, its PC inbox, its tablet - each marked RESENT, because the
 * point is a kitchen that never got it (Firecracker's Pizza's two orders on
 * 2026-09-29 were never emailed) and is meant to make it.
 *
 * Where it goes is the restaurant's CURRENT setup, not what it was when the
 * order arrived: that is what fixes an order lost to a setup that was wrong
 * at the time. The today-only rule is the caller's (resendRefusal).
 *
 * Each channel succeeds or fails on its own and says so; one failing never
 * stops the others.
 */
export interface ResendChannelResult {
  channel: OrderDestination;
  ok: boolean;
  detail: string;
}

export interface ResendResult {
  destinations: OrderDestination[];
  channels: ResendChannelResult[];
}

export async function resendOrder(order: Record<string, any>, actor: string): Promise<ResendResult> {
  const admin = supabaseAdmin();
  const { data: r } = await admin
    .from("restaurants")
    .select("id, name, print_method, app_expected, ticket_email_to, ticket_footer_text, ticket_footer_url, ticket_logo_b64, ticket_design_style")
    .eq("id", order.restaurant_id)
    .maybeSingle();
  const { data: devices } = await admin
    .from("print_devices")
    .select("id")
    .eq("restaurant_id", order.restaurant_id)
    .eq("is_active", true);

  const destinations = orderDestinations({
    print_method: r?.print_method ?? null,
    app_expected: r?.app_expected ?? null,
    hasActivePrinter: (devices?.length ?? 0) > 0,
  });
  const by = resendBy(`crm:${actor}`);
  const channels: ResendChannelResult[] = [];

  for (const d of destinations) {
    try {
      if (d === "printer") channels.push(await resendToPrinters(order, by));
      else if (d === "email") channels.push(await resendByEmail(order, r ?? {}, by));
      else channels.push(await resendToTablet(order, by));
    } catch (err) {
      channels.push({ channel: d, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return { destinations, channels };
}

async function resendToPrinters(order: Record<string, any>, by: ReturnType<typeof resendBy>): Promise<ResendChannelResult> {
  const result = await queueOrderToPrinters(order.id, order.restaurant_id, { queuedBy: by, receivedAt: order.received_at ?? null });
  if (result.refusal) return { channel: "printer", ok: false, detail: result.message ?? result.refusal };
  const names = result.queued.map((q) => q.deviceName).filter(Boolean).join(", ");
  return { channel: "printer", ok: result.queued.length > 0, detail: result.queued.length ? `Queued on ${names}; it prints on the next poll, marked RESENT.` : "No printer took the job." };
}

async function resendByEmail(order: Record<string, any>, r: Record<string, any>, by: string): Promise<ResendChannelResult> {
  const admin = supabaseAdmin();
  const to = (r.ticket_email_to ?? "").trim();
  if (!to) return { channel: "email", ok: false, detail: "print_method is 'email' but ticket_email_to is empty" };

  const { composeBrandedTicketEmail, markResent, sendTicketEmail } = await import("./email-out");
  const composed = await composeBrandedTicketEmail(order as any, {
    footer: { text: r.ticket_footer_text, url: r.ticket_footer_url },
    logo: r.ticket_logo_b64 ? Buffer.from(r.ticket_logo_b64, "base64") : null,
    design: { style: r.ticket_design_style },
  });
  const email = markResent(composed, resentBanner(order.order_number));
  const result = await sendTicketEmail(to, email);
  const now = new Date().toISOString();
  console.log(
    result.ok ? "order resend email SENT" : "order resend email FAILED",
    JSON.stringify({ order: order.id, to, subject: email.subject, by, message_id: result.messageId ?? null, error: result.error ?? null })
  );

  // The order's one email job (partial unique index) records that an email
  // left - what /orders reads as EMAILED. A failed resend never overwrites
  // an earlier success; with no job yet (the restaurant was not on email
  // when the order came in) the resend creates it.
  const { data: job } = await admin
    .from("print_jobs")
    .select("id, sent_at")
    .eq("order_id", order.id)
    .eq("delivery", "email")
    .maybeSingle();
  const patch = result.ok
    ? { status: "printed", sent_at: now, send_error: null, finished_at: now, queued_by: by }
    : { status: "failed", send_error: result.error ?? "unknown", finished_at: now, queued_by: by };
  if (job) {
    if (result.ok || !job.sent_at) await admin.from("print_jobs").update(patch).eq("id", job.id);
  } else {
    await admin.from("print_jobs").insert({ order_id: order.id, device_id: null, delivery: "email", ...patch });
  }

  if (!result.ok) return { channel: "email", ok: false, detail: result.error ?? "the email was not sent" };
  return { channel: "email", ok: true, detail: `Emailed to ${to} - subject '${email.subject}'.` };
}

async function resendToTablet(order: Record<string, any>, by: string): Promise<ResendChannelResult> {
  const admin = supabaseAdmin();
  const total = order.customer_total == null ? null : Number(order.customer_total);
  const push = await notifyRestaurant(order.restaurant_id, {
    title: `Resent Order #${order.order_number}`,
    body: total ? `${order.customer_name || "Customer"} - $${total.toFixed(2)}` : "Tap to view the order",
    orderId: order.id,
  });
  const now = new Date().toISOString();
  const outcome = appDeliveryOutcome(push, now);
  await admin
    .from("print_jobs")
    .update({
      status: outcome.status,
      delivered_count: outcome.delivered_count,
      sent_at: outcome.sent_at,
      send_error: outcome.send_error,
      finished_at: now,
      queued_by: by,
    })
    .eq("order_id", order.id)
    .eq("delivery", "app");
  return outcome.status === "printed"
    ? { channel: "app", ok: true, detail: `Pushed to ${outcome.delivered_count} tablet(s).` }
    : { channel: "app", ok: false, detail: `Nothing reached a tablet: ${outcome.send_error}` };
}
