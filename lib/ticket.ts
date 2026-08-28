/**
 * Canonical receipt-ticket renderer.
 *
 * Builds a ticket as structured lines, then renders them to Epson ePOS-Print
 * XML. Used by the Server Direct Print endpoint, where the printer polls us
 * directly and there is no agent on site to do the formatting.
 *
 * print-agent/agent.mjs carries a JS port of this same layout for the
 * LAN/USB transports. Keep the two in step - the ticket a restaurant sees
 * must not depend on which transport happens to be in use.
 */

export interface TicketLine {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  size?: "normal" | "double" | "double-h";
  /** White-on-black. The strongest emphasis ESC/POS has; used once, on the
   *  one fact that decides where the food goes. */
  reverse?: boolean;
  /** Renders a QR symbol instead of text. `text` is ignored when set. */
  qr?: string;
}

/** Footer block, resolved per restaurant with a global fallback. */
export interface TicketFooter {
  text?: string | null;
  url?: string | null;
}

export const DEFAULT_FOOTER_TEXT =
  process.env.TICKET_FOOTER_DEFAULT ||
  "Powered by Premium Food Delivery\npfdworks.com";

export interface TicketOrder {
  order_number?: string | null;
  source?: string | null;
  ticket_restaurant_name?: string | null;
  order_type?: string | null;
  due_time?: string | null;
  received_at?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  items?: { name?: string; price?: string | number | null; modifiers?: string[] }[] | null;
  items_total?: number | string | null;
  tax?: number | string | null;
  service_fee?: number | string | null;
  delivery_fee?: number | string | null;
  tip?: number | string | null;
  customer_total?: number | string | null;
  payment_type?: string | null;
  notes?: string | null;
}

const L = (text: string, opts: Partial<TicketLine> = {}): TicketLine => ({ text, ...opts });

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function fmt(v: unknown): string | null {
  const n = money(v);
  return n === null ? null : `$${n.toFixed(2)}`;
}

/** Value flushed right within `cols`. */
function pad(left: string, right: string, cols: number): string {
  const gap = cols - left.length - right.length;
  return gap >= 1 ? left + " ".repeat(gap) + right : `${left} ${right}`;
}

function wrap(text: string, cols: number): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > cols && line) {
      out.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function localTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: process.env.TICKET_TIMEZONE || "America/Chicago",
  });
}

export function buildTicket(
  order: TicketOrder,
  cols = 48,
  footer: TicketFooter = {}
): TicketLine[] {
  const rule = "-".repeat(cols);
  const heavy = "=".repeat(cols);
  const lines: TicketLine[] = [];

  // --- Headline: where the food goes, and when -----------------------------
  // This block leads the ticket because it is what a cook needs first and
  // what determines handling. The restaurant's own name used to sit here in
  // double height, which spent the best four lines on the one fact everyone
  // in the room already knows.
  const type = (order.order_type || "order").toUpperCase();
  lines.push(L(`  ${type.split("").join(" ")}  `, {
    align: "center", size: "double-h", bold: true, reverse: true,
  }));

  const due = localTime(order.due_time);
  if (due) {
    // A due time before the order was placed means a replayed or backfilled
    // order, not a real deadline. Say so rather than letting the kitchen read
    // it as urgently late.
    const dueMs = order.due_time ? new Date(order.due_time).getTime() : NaN;
    const recvMs = order.received_at ? new Date(order.received_at).getTime() : NaN;
    const stale = Number.isFinite(dueMs) && Number.isFinite(recvMs) && dueMs < recvMs;
    lines.push(L(`DUE  ${due}${stale ? "  (PAST)" : ""}`, {
      align: "center", size: "double-h", bold: true,
    }));
  }
  lines.push(L(heavy));

  lines.push(L(order.ticket_restaurant_name || "PFD ORDER", { align: "center" }));
  lines.push(L(rule));

  const recv = localTime(order.received_at);
  lines.push(L(pad(`ORDER #${order.order_number ?? "?"}`, recv ? `placed ${recv}` : "", cols)));
  lines.push(L(rule));

  // --- Who it is for -------------------------------------------------------
  if (order.customer_name) lines.push(L(order.customer_name, { bold: true }));
  if (order.customer_phone) lines.push(L(order.customer_phone));
  if (order.customer_address) {
    // The address gets its own block. A driver reads this under time
    // pressure, often in the dark, and it must not run into the phone number.
    lines.push(L(""));
    // The mapper joins address, cross street and delivery instructions with
    // " | ", which reads fine in a database and badly on paper - a pipe in
    // the middle of a street address is noise a driver has to parse past.
    // The street is the address; anything after it is an instruction.
    const [street, ...instructions] = String(order.customer_address).split(" | ");
    for (const l of wrap(street, cols)) lines.push(L(l, { bold: true }));
    for (const ins of instructions) {
      for (const l of wrap(ins, cols - 3)) lines.push(L(`>> ${l}`, { bold: true }));
    }
  }
  if (order.customer_name || order.customer_phone || order.customer_address) {
    lines.push(L(rule));
  }

  // --- Items ---------------------------------------------------------------
  // Quantity gets its own left column. Folded into the name as "2x Burger" it
  // is the easiest thing on the ticket to miss when scanning during a rush,
  // and a missed count is a remake.
  lines.push(L(pad(" QTY  ITEM", "AMOUNT", cols)));
  lines.push(L(rule));

  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) lines.push(L("(no itemization available)"));

  const QTY_W = 3;
  const NAME_INDENT = QTY_W + 3;
  items.forEach((it, idx) => {
    if (idx > 0) lines.push(L(""));   // items must not read as one block
    const { qty, name } = splitQuantity(it?.name ?? "Item", it as any);
    const price = typeof it?.price === "string" ? it.price : fmt(it?.price);
    const nameW = cols - NAME_INDENT - (price ? price.length + 1 : 0);
    const wrapped = wrap(name.toUpperCase(), Math.max(8, nameW));
    const qtyCell = String(qty).padStart(QTY_W);
    lines.push(L(pad(`${qtyCell}   ${wrapped[0]}`, price ?? "", cols), { bold: true }));
    for (const extra of wrapped.slice(1)) {
      lines.push(L(" ".repeat(NAME_INDENT) + extra, { bold: true }));
    }
    for (const mod of it?.modifiers ?? []) {
      // Bold, because the modifier is the part that ruins a plate if missed -
      // it used to print lighter than the item it modifies, which is backwards.
      for (const l of wrap(mod, cols - NAME_INDENT - 3)) {
        lines.push(L(`${" ".repeat(NAME_INDENT)}>> ${l}`, { bold: true }));
      }
    }
  });
  lines.push(L(rule));

  // --- Money ---------------------------------------------------------------
  for (const [label, v] of [
    ["Subtotal", order.items_total],
    ["Tax", order.tax],
    ["Service", order.service_fee],
    ["Delivery", order.delivery_fee],
  ] as const) {
    const f = fmt(v);
    if (f !== null) lines.push(L(pad(label, f, cols)));
  }
  // The tip is the DRIVER's money - it prints on its own line, never buried.
  const tip = fmt(order.tip);
  if (tip !== null) lines.push(L(pad("TIP (driver)", tip, cols), { bold: true }));

  const total = fmt(order.customer_total);
  if (total !== null) {
    lines.push(L(rule));
    lines.push(L(pad("TOTAL", total, cols), { bold: true, size: "double-h" }));
  }
  if (order.payment_type) lines.push(L(pad("Paid", String(order.payment_type), cols)));

  if (order.notes) {
    lines.push(L(rule));
    lines.push(L("NOTE:", { bold: true }));
    for (const l of wrap(order.notes, cols)) lines.push(L(l, { bold: true }));
  }

  // --- Footer --------------------------------------------------------------
  // Whitespace before it on purpose: this is the part a customer keeps, and
  // it has to survive being torn off above the perforation.
  lines.push(L(heavy));
  for (let i = 0; i < 4; i++) lines.push(L(""));

  const footerText = (footer.text ?? "").trim() || DEFAULT_FOOTER_TEXT;
  for (const para of footerText.split(/\r?\n/)) {
    for (const l of wrap(para, cols)) lines.push(L(l, { align: "center" }));
  }

  if (footer.url) {
    lines.push(L(""));
    lines.push(L("Scan to order again", { align: "center" }));
    lines.push(L(""));
    lines.push({ text: "", align: "center", qr: footer.url });
  }

  return lines;
}

/**
 * Pulls a leading quantity out of the item name.
 *
 * The mapper folds quantity into the name ("2x Cheeseburger") because that is
 * what the old single-column layout wanted. Rather than change the canonical
 * shape - which is stored on every existing order and replayed from - the
 * renderer unfolds it, so historic orders reprint correctly too.
 */
function splitQuantity(rawName: string, it?: { quantity?: number }): { qty: number; name: string } {
  if (typeof it?.quantity === "number" && it.quantity > 0) {
    return { qty: it.quantity, name: rawName };
  }
  const m = /^\s*(\d+)\s*x\s+(.*)$/i.exec(rawName);
  if (m) return { qty: parseInt(m[1], 10), name: m[2] };
  return { qty: 1, name: rawName };
}

export function xmlEscape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The <epos-print> element - embedded in <PrintData> for Server Direct Print. */
export function toEposPrintXml(lines: TicketLine[], cols = 48): string {
  const body = lines
    .map((line) => {
      const align = line.align === "center" ? "center" : line.align === "right" ? "right" : "left";

      // QR: ePOS-Print draws the symbol natively, so there is no image to
      // encode. Alignment is set by a preceding empty text element, since
      // <symbol> carries no align attribute of its own.
      if (line.qr) {
        return (
          `<text align="${align}"/>` +
          `<symbol type="qrcode_model_2" level="level_m" width="5" height="5">` +
          `${xmlEscape(line.qr)}</symbol>` +
          `<feed line="1"/>`
        );
      }

      const t = line.text ?? "";
      // Double WIDTH halves the usable columns, so a long line would run off
      // the paper. Fall back to double height rather than clipping it.
      const dbl = line.size === "double" && t.length <= Math.floor(cols / 2);
      const w = dbl ? 2 : 1;
      const h = line.size === "double" || line.size === "double-h" ? 2 : 1;
      return (
        `<text align="${align}" em="${line.bold ? "true" : "false"}"` +
        ` reverse="${line.reverse ? "true" : "false"}"` +
        ` width="${w}" height="${h}">${xmlEscape(t)}&#10;</text>`
      );
    })
    .join("");

  return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}<feed line="3"/><cut type="feed"/></epos-print>`;
}
