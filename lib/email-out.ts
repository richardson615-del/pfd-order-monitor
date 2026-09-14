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

/**
 * Column width for emailed tickets.
 *
 * NOT 48. That is the thermal head's width at 203dpi; Automatic Email Manager
 * prints through a Windows driver at its own font size, and on the first live
 * ticket at Greek Style Gyro it cut everything past roughly column 33 - every
 * item price, every subtotal, the TOTAL, and the tail of a modifier reading
 * "no beef - only chicken &". A ticket without prices is not a degraded
 * ticket, it is a broken one.
 *
 * 32 is the standard narrow-receipt width and leaves margin against a driver
 * that renders slightly wider than measured. Override per deployment if a
 * site's printer differs.
 */
export const EMAIL_TICKET_COLS = Number(process.env.TICKET_EMAIL_COLS || 32);

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

/**
 * The printable HTML body.
 *
 * BOLD on purpose. The first live ticket at Greek Style Gyro printed legibly
 * but faint - Automatic Email Manager renders the HTML part through a Windows
 * driver, and Courier New's light stems come out weak on thermal paper.
 * Courier New Bold has the SAME advance width, so this darkens the ticket
 * without costing a single column, which a larger font size would.
 *
 * Colour is stated explicitly: some print paths render default text as dark
 * grey, which on thermal stock is the difference between readable and not.
 */
function wrapTicketHtml(text: string): string {
  return (
    `<html><body style="margin:0">` +
    `<pre style="font-family:'Courier New',Courier,monospace;` +
    `font-size:13px;font-weight:bold;color:#000;` +
    `line-height:1.35;white-space:pre;margin:0">` +
    escapeHtml(text) +
    `</pre></body></html>`
  );
}

/**
 * The HTML part, styled to match the Epson ticket.
 *
 * The thermal ticket leads with a knockout PICKUP/DELIVERY banner and sets
 * DUE and TOTAL at double height, because those three facts decide what a
 * cook does and when. The plain-text version cannot express any of that -
 * text has no weight, no size and no reverse video - so the emailed ticket
 * read flat next to its printed counterpart.
 *
 * HTML can. The banner is a black block with white type, DUE and TOTAL are
 * simply larger, and the body stays in the monospace <pre> that is already
 * printing correctly at 32 columns. Structure around the body, not through
 * it: the column alignment is the part that took two rounds to get right and
 * it is not worth risking for styling.
 *
 * The plain-text part is UNCHANGED and still complete, so a client that
 * prefers text loses the styling and nothing else.
 */
function wrapTicketHtmlStyled(
  text: string,
  parts: { banner: string; due: string | null; total: string | null }
): string {
  const mono = "font-family:'Courier New',Courier,monospace";
  const W = "max-width:34ch";
  return (
    `<html><body style="margin:0;${mono};color:#000">` +
    `<div style="${W}">` +
    // Knockout banner - the one fact that decides where the food goes.
    `<div style="background:#000;color:#fff;font-weight:bold;font-size:19px;` +
    `text-align:center;letter-spacing:3px;padding:4px 0;margin:0 0 4px">` +
    escapeHtml(parts.banner) +
    `</div>` +
    (parts.due
      ? `<div style="text-align:center;font-weight:bold;font-size:16px;margin:0 0 4px">` +
        escapeHtml(parts.due) + `</div>`
      : "") +
    `<pre style="${mono};font-size:13px;font-weight:bold;line-height:1.35;` +
    `white-space:pre;margin:0">` + escapeHtml(text) + `</pre>` +
    (parts.total
      ? `<div style="border-top:2px solid #000;margin-top:4px;padding-top:4px;` +
        `font-weight:bold;font-size:17px;white-space:pre">` +
        escapeHtml(parts.total) + `</div>`
      : "") +
    `</div></body></html>`
  );
}

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
  const cols = opts.cols ?? EMAIL_TICKET_COLS;
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

  // The HTML part promotes the three lines the thermal ticket emphasises and
  // drops them from the <pre>, so nothing is printed twice.
  const bodyLines = text.split("\n");
  const bannerIdx = bodyLines.findIndex((l) => /^\s*[A-Z](\s[A-Z])+\s*$/.test(l));
  const dueIdx = bodyLines.findIndex((l) => /^\s*DUE\s/.test(l));
  const totalIdx = bodyLines.findIndex((l) => /^TOTAL\s/.test(l));
  const dueLine = dueIdx >= 0 ? bodyLines[dueIdx].trim() : null;
  const totalLine = totalIdx >= 0 ? bodyLines[totalIdx] : null;
  const htmlBody = bodyLines
    .filter((_, i) => i !== bannerIdx && i !== dueIdx && i !== totalIdx)
    .join("\n")
    .replace(/^\n+/, "");

  // <pre> in a monospace face: the ticket is column-aligned, and a
  // proportional font would break every total and every quantity column.
  const html = wrapTicketHtmlStyled(htmlBody, {
    banner: type.split("").join(" "),
    due: dueLine,
    total: totalLine,
  });

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
  return { subject, text, html: wrapTicketHtml(text) };
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

/**
 * A readable plain-text fallback derived from HTML.
 *
 * Every message goes out multipart/alternative. An HTML-only email is more
 * likely to be filtered, and unreadable to anyone whose client shows text -
 * which for a financial document sent to a restaurant owner is a bad way to
 * find out. The CRM may supply its own `text`; this is what happens when it
 * does not.
 *
 * Deliberately crude. It exists so the message is not empty in a text client,
 * not to reproduce a statement's layout - and pretending otherwise would
 * invite someone to rely on it.
 */
export function htmlToPlainText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sends an arbitrary composed email as the PFD identity. */
export async function sendComposedEmail(
  to: string,
  email: TicketEmail
): Promise<SendResult> {
  return sendTicketEmail(to, email);
}

/**
 * The branded ticket email - the same raster header and footer the Epson
 * path prints, embedded as images.
 *
 * Images are data: URIs rather than CID attachments. AEM renders the HTML
 * part through a Windows engine, and a data: URI survives the message being
 * extracted and printed standalone, where a CID reference depends on the
 * renderer still having the MIME container to resolve against. Self-contained
 * is the safer bet for something whose renderer we cannot inspect.
 *
 * The PLAIN-TEXT part is unchanged and still complete - logo and QR degrade
 * to the restaurant name and a bare URL. A client that shows text loses the
 * branding and none of the order.
 *
 * Any failure to render falls back to the styled text-only HTML. A logo is
 * decoration; the ticket is dinner.
 */
export async function composeBrandedTicketEmail(
  order: TicketOrder,
  opts: {
    footer?: TicketFooter;
    logo?: Buffer | null;
    design?: { style?: string | null } | null;
    cols?: number;
  } = {}
): Promise<TicketEmail> {
  const base = composeTicketEmail(order, { footer: opts.footer, cols: opts.cols });
  const hasBranding = Boolean(opts.logo) || Boolean(opts.footer?.url);
  if (!hasBranding) return base;

  try {
    const { renderHeader, renderFooter, canvasToPng, DEFAULT_FOOTER_TEXT_MARK } =
      await import("./ticket-raster");

    const cols = opts.cols ?? EMAIL_TICKET_COLS;
    const lines = buildTicket(order, cols, opts.footer ?? {}, { scale: "normal" });
    const textLines = lines.map((l) => l.text ?? "");

    // The body only: the raster blocks own everything above ORDER # and
    // everything from the heavy rule down, exactly as on the Epson path.
    const start = textLines.findIndex((t) => /^ORDER #/.test(t));
    const end = textLines.findIndex((t, i) => i > start && /^=+$/.test(t));
    const body = toPlainText(
      lines.slice(start === -1 ? 0 : start, end === -1 ? lines.length : end),
      cols
    );

    const dueLine = textLines.find((t) => /^DUE /.test(t)) ?? null;
    const design = { style: (opts.design?.style as any) ?? "bold" };

    const header = await renderHeader({
      restaurantName: order.ticket_restaurant_name || "PFD ORDER",
      orderType: order.order_type || "order",
      dueText: dueLine,
      design,
      logo: opts.logo ?? null,
    });
    const footer = await renderFooter({
      text: (opts.footer?.text || "").trim() || DEFAULT_FOOTER_TEXT_MARK,
      url: opts.footer?.url ?? null,
      design,
    });

    const img = (png: Buffer) =>
      `<img src="data:image/png;base64,${png.toString("base64")}" ` +
      `style="width:100%;display:block;margin:0" alt="">`;

    const mono = "font-family:'Courier New',Courier,monospace";
    const html =
      `<html><body style="margin:0;${mono};color:#000">` +
      `<div style="max-width:34ch">` +
      img(canvasToPng(header)) +
      `<pre style="${mono};font-size:13px;font-weight:bold;line-height:1.35;` +
      `white-space:pre;margin:0">` + escapeHtml(body) + `</pre>` +
      img(canvasToPng(footer)) +
      `</div></body></html>`;

    return { subject: base.subject, text: base.text, html };
  } catch (err) {
    console.error(
      "branded ticket render failed, sending text-only:",
      err instanceof Error ? err.message : err
    );
    return base;
  }
}
