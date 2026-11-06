/**
 * Paper-ticket email: CRM orders only (Nick, 2026-11-06).
 *
 * A restaurant on "Email to a PC" whose PC inbox also gets Zuppler's own
 * order email was receiving every Zuppler order twice. With
 * restaurants.email_crm_orders_only on (migration 057, default off), the
 * PC-inbox email goes only for orders placed in the CRM - a phone order
 * (source 'phone', P- numbers) - and every other order skips this
 * destination. Off = exactly the behaviour before.
 *
 * Pure: ingest (lib/canonical.ts), Resend (lib/order-resend.ts), the
 * cancellation email and the CRM orders feed (lib/crm-orders.ts) all ask
 * this one function, so they cannot disagree.
 */

export type EmailSkipReason = "zuppler" | "not_crm_order";

/** What "Where it went" says for a skipped order. */
export const EMAIL_SKIP_TEXT: Record<EmailSkipReason, string> = {
  zuppler: "Skipped — restaurant receives Zuppler email directly",
  not_crm_order: "Skipped — this restaurant's PC email is for CRM orders only",
};

/** An order placed in the CRM: a phone order, or a test order (the CRM's "send a test" is how the PC is checked). */
export function isCrmOrder(order: { source?: string | null; order_number?: string | null }): boolean {
  if (order.source === "phone" || order.source === "test") return true;
  return /^P-/i.test((order.order_number ?? "").trim()) && order.source !== "zuppler" && order.source !== "email";
}

/**
 * Why this order's ticket email is not sent to the PC inbox, or null when it
 * is. Only ever non-null with the toggle on. Zuppler orders (webhook, or the
 * older Zuppler-email ingest) say so in their own words.
 */
export function emailSkipReason(
  restaurant: { email_crm_orders_only?: boolean | null },
  order: { source?: string | null; order_number?: string | null }
): EmailSkipReason | null {
  if (!restaurant.email_crm_orders_only) return null;
  if (isCrmOrder(order)) return null;
  return order.source === "zuppler" || order.source === "email" ? "zuppler" : "not_crm_order";
}
