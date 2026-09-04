import { google } from "googleapis";
import { getOAuthClient } from "./gmail";
import { buildTicket, toPlainText, TicketOrder, TicketFooter } from "./ticket";

/**
 * Outbound ticket email - the Automatic Email Manager bridge.
 *
 * Some restaurants print by watching a mailbox with AEM on a local PC. For
 * them the ticket travels as mail rather than as an Epson job, and AEM prints
 * whatever arrives. That makes the SUBJECT load-bearing: AEM matches on it to
 * decide what to print, so the format below is a contract with a rule someone
 * configured at the restaurant, not a nicety.
 *
 * Text only. No raster header, logo or QR - those exist as bitmaps inside an
 * ePOS document and have no meaning in a mail body that a Windows print
 * driver will render.
 */

export const SENDER_ADDRESS = process.env.TICKET_EMAIL_FROM || "info@pfdworks.com";

/** Base64url, as the Gmail API expects a raw RFC822 message. */
const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 2047 encoding, so a restaurant name with an accent survives the header. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface TicketEmail {
  subject: string;
  text: string;
  html: string;
}

function dueLabel(order: TicketOrder): string {
  const iso = order.due_time;
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: process.env.TICKET_TIMEZONE || "America/Chicago",
  });
}

/**
 * Builds the ticket email for an order.
 *
 * The subject must start with "PFD ORDER" - that prefix is what the AEM rule
 * at the restaurant matches on. Changing it silently stops their printing.
 */
export function composeTicketEmail(
  order: TicketOrder,
  opts: { footer?: TicketFooter; cols?: number } = {}
): TicketEmail {
  const cols = opts.cols ?? 48;
  // ALWAYS normal scale, whatever the restaurant's ticket_text_scale says.
  //
  // Large print lays enlarged lines out at 24 columns because the thermal
  // head renders them double-width, visually filling the same 48. Plain text
  // has no double-width, so those lines come out half the width of everything
  // around them and the ticket reads as broken - the item price and the TOTAL
  // land mid-line while the subtotal sits at the margin.
  //
  // The accessibility reason for large print does not apply here either: it
  // exists because 48-column thermal text is hard to read at arm's length,
  // and AEM prints to an ordinary printer where font size is the printer's
  // business, not ours.
  const lines = buildTicket(order, cols, opts.footer ?? {}, { scale: "normal" });
  const text = toPlainText(lines, cols);

  const type = (order.order_type || "order").toUpperCase();
  const due = dueLabel(order);
  const subject =
    `PFD ORDER #${order.order_number ?? "?"} - ${type}${due ? ` ${due}` : ""}`;

  // <pre> in a monospace face: the ticket is column-aligned, and a
  // proportional font would break every total and every quantity column.
  const html =
    `<html><body style="margin:0"><pre style="font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.35;white-space:pre;margin:0">` +
    escapeHtml(text) +
    `</pre></body></html>`;

  return { subject, text, html };
}

/** Cancellation notice, mirroring how a queued Epson job is killed today. */
export function composeCancellationEmail(order: TicketOrder): TicketEmail {
  const subject = `CANCELLED - ORDER #${order.order_number ?? "?"}`;
  const text = [
    "*** ORDER CANCELLED ***",
    "",
    `Order #${order.order_number ?? "?"}`,
    order.customer_name ? `Customer: ${order.customer_name}` : null,
    order.customer_total != null ? `Total: $${Number(order.customer_total).toFixed(2)}` : null,
    "",
    "This order has been cancelled. Do not prepare it.",
    "If it is already being made, stop.",
  ].filter(Boolean).join("\n");
  const html =
    `<html><body style="margin:0"><pre style="font-family:'Courier New',Courier,monospace;font-size:13px;white-space:pre;margin:0">` +
    escapeHtml(text) + `</pre></body></html>`;
  return { subject, text, html };
}

/** Multipart/alternative RFC822 message. */
export function buildRawMessage(to: string, from: string, email: TicketEmail): string {
  const boundary = `pfd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends as the PFD identity. Never throws - a send failure must be recorded
 * on the job row and surfaced by the monitor, not raised into the ingest path
 * where it would fail an order that is otherwise fine.
 */
export async function sendTicketEmail(to: string, email: TicketEmail): Promise<SendResult> {
  const refreshToken = process.env.TICKET_EMAIL_REFRESH_TOKEN;
  if (!refreshToken) {
    return {
      ok: false,
      error:
        "TICKET_EMAIL_REFRESH_TOKEN is not set - no Gmail send grant exists for " +
        SENDER_ADDRESS + ". Connect it before enabling email delivery.",
    };
  }
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: `invalid destination address: ${to || "(empty)"}` };
  }

  try {
    const auth = getOAuthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: b64url(buildRawMessage(to, SENDER_ADDRESS, email)) },
    });
    return { ok: true, messageId: res.data.id ?? undefined };
  } catch (err: any) {
    const detail =
      err?.response?.data?.error?.message ?? err?.message ?? String(err);
    return { ok: false, error: String(detail).slice(0, 400) };
  }
}
