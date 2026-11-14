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

import { displayOrderNo, orderSourceRef } from "./order-label";
import { cateringText } from "./catering-text";
import { isAdvanceOrder } from "./advance-order";

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

export type TextScale = "normal" | "large";

/**
 * A payment_type that is a whole instruction rather than a tender name:
 * "PAID - CARD ****1234", "CASH DUE $42.10" (phone orders, lib/phone-order.ts
 * tenderLine). Such a value prints as itself, bold, with no "Paid" label.
 */
export const TENDER_LINE_RE = /^(PAID - |CASH DUE |CARD DUE |HOUSE ACCOUNT)/;

export interface TicketOptions {
  /**
   * "large" doubles the parts a cook reads: quantities, item names,
   * modifiers, the customer name and the due time. Double width halves the
   * usable columns, so those lines are laid out at 24 rather than 48 - the
   * layout changes, it is not the same ticket scaled up.
   */
  scale?: TextScale;
  /**
   * Drop the customer-facing footer block.
   *
   * On paper the footer is the part the customer keeps - whitespace, the PFD
   * line, a QR - printed below the total so it survives being torn off. On the
   * tablet there is nothing to tear off, and it would put four blank lines and
   * a coupon between the cook and the next order. The order itself is
   * identical either way.
   */
  omitFooter?: boolean;
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
  /** 059: the plain per-restaurant number; prints as ORDER #12 with order_number as "Ref" under it. */
  ticket_no?: number | null;
  source?: string | null;
  ticket_restaurant_name?: string | null;
  order_type?: string | null;
  due_time?: string | null;
  received_at?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  /** `note` (TK2): the customer's own words on this item. The mapper also leaves it as the last modifier, for readers that predate it. */
  items?: { name?: string; price?: string | number | null; modifiers?: string[]; note?: string | null }[] | null;
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

/**
 * The kitchen note and the discount, apart. The Zuppler mapper appends "Discount applied: $8.00" to the customer's
 * note with " | " (lib/zuppler-mapper.ts), which put a money line in the cook's instructions. Pure.
 */
export function splitTicketNotes(notes: string | null | undefined): { kitchen: string | null; discount: string | null } {
  let discount: string | null = null;
  const parts = String(notes ?? "")
    .split(" | ")
    .map((p) => p.trim())
    .filter((p) => {
      const m = p.match(/^Discount applied:\s*\$?([0-9]+(?:\.[0-9]{1,2})?)$/i);
      if (m) {
        discount = `-$${Number(m[1]).toFixed(2)}`;
        return false;
      }
      return p.length > 0;
    });
  return { kitchen: parts.length ? parts.join(" | ") : null, discount };
}

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

/** The long label when it fits the room, else the short one (narrow emailed tickets). */
const fit = (long: string, short: string, room: number): string => (long.length <= room ? long : short);

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
  footer: TicketFooter = {},
  opts: TicketOptions = {}
): TicketLine[] {
  const large = opts.scale === "large";
  // Double WIDTH halves the columns. Everything enlarged is laid out against
  // this, so a wrapped item name still lands inside the paper.
  const bigCols = Math.floor(cols / 2);
  const rule = "-".repeat(cols);
  const heavy = "=".repeat(cols);
  const dotted = ". ".repeat(Math.floor(cols / 2)).trimEnd();
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
    // CRM Ticket #1429: an order placed for later says so above its due time,
    // so a ticket that prints early (printer-only restaurants) is not cooked early.
    if (!stale && isAdvanceOrder(order)) {
      lines.push(L("ADVANCE ORDER", { align: "center", bold: true, reverse: true }));
    }
    const dueText = `DUE  ${due}${stale ? "  (PAST)" : ""}`;
    lines.push(L(dueText, {
      align: "center", bold: true,
      // Double WIDTH only if it fits the halved column count; the renderer
      // falls back on its own, but choosing here keeps the intent explicit.
      size: large && dueText.length <= bigCols ? "double" : "double-h",
    }));
  }
  lines.push(L(heavy));

  lines.push(L(order.ticket_restaurant_name || "PFD ORDER", { align: "center" }));
  lines.push(L(rule));

  const recv = localTime(order.received_at);
  const orderLabel = `ORDER #${displayOrderNo(order)}`;
  const sourceRef = orderSourceRef(order);
  const placed = recv ? `placed ${recv}` : "";
  // pad() overflows rather than truncating when the two halves do not fit,
  // which on a narrow ticket pushed this line past the paper edge - the order
  // number survived and the time ran off. Split instead.
  if (placed && orderLabel.length + placed.length + 1 > cols) {
    lines.push(L(orderLabel));
    // At 24 columns (large emailed tickets) "placed Thu, Sep 3, 5:40 PM" is itself too wide.
    for (const l of wrap(placed, cols)) lines.push(L(l));
  } else {
    lines.push(L(pad(orderLabel, placed, cols)));
  }
  // 059: the source's own number, small, for looking the order up in Zuppler or the CRM.
  if (sourceRef) lines.push(L(`Ref ${sourceRef}`));
  lines.push(L(rule));

  // --- Who it is for -------------------------------------------------------
  if (order.customer_name) {
    lines.push(L(order.customer_name, large
      ? { bold: true, size: "double" }
      : { bold: true }));
  }
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

  // Narrower gutter in large mode: at 24 columns a 3-wide quantity field
  // plus a 3-space gap would eat a quarter of the line before the name starts.
  const QTY_W = large ? 2 : 3;
  const NAME_INDENT = large ? QTY_W + 2 : QTY_W + 3;
  const W = large ? bigCols : cols;
  const itemAttrs: Partial<TicketLine> = large
    ? { bold: true, size: "double" }
    : { bold: true };

  items.forEach((it, idx) => {
    // TK2: a dotted rule, not a blank line. On a long order a blank line was
    // too weak to say where one plate ends and the next begins.
    if (idx > 0) lines.push(L(dotted));
    const { qty, name } = splitQuantity(it?.name ?? "Item", it as any);
    const price = typeof it?.price === "string" ? it.price : fmt(it?.price);
    const qtyCell = String(qty).padStart(QTY_W);
    const gap = large ? "  " : "   ";

    if (large) {
      // The name gets the full width; the price joins the LAST line of it if
      // there is room. A price on a line of its own sits between the item and
      // its modifiers and reads as belonging to them - which is worse than
      // slightly tighter setting.
      const wrapped = wrap(name.toUpperCase(), Math.max(6, W - NAME_INDENT));
      const rendered = wrapped.map((part, i) =>
        i === 0 ? `${qtyCell}${gap}${part}` : " ".repeat(NAME_INDENT) + part
      );
      const last = rendered[rendered.length - 1];
      if (price && last.length + 1 + price.length <= W) {
        rendered[rendered.length - 1] = pad(last, price, W);
      }
      for (const line of rendered) lines.push(L(line, itemAttrs));
      // TK2: when the price did not fit beside the name it takes the next line, same size, right edge - where
      // every other item's price already sits. It used to trail the modifiers in small print, directly above the
      // NEXT item, and read as that item's price.
      if (price && rendered[rendered.length - 1] === last) lines.push(L(pad("", price, W), itemAttrs));
    } else {
      const nameW = cols - NAME_INDENT - (price ? price.length + 1 : 0);
      const wrapped = wrap(name.toUpperCase(), Math.max(8, nameW));
      lines.push(L(pad(`${qtyCell}${gap}${wrapped[0]}`, price ?? "", cols), itemAttrs));
      for (const extra of wrapped.slice(1)) {
        lines.push(L(" ".repeat(NAME_INDENT) + extra, itemAttrs));
      }
    }

    // --- What goes on the plate (TK2, Matt 2026-11-14: "too cluttered now and confusing") -------------------
    // One choice per line, each starting with a dash. A choice that wraps continues indented with NO dash, so
    // "Loaded Garlic / Mashed Potatoes" can no longer be read as two sides. An add-on's price sits at the right
    // edge of its own line instead of wrapping onto a line of its own. In large mode the choices print tall but
    // not wide (48 columns), so nearly every one fits on a single line and the item name stays the biggest thing.
    const { mods, note } = splitItemNote(it);
    const modAttrs: Partial<TicketLine> = large ? { bold: true, size: "double-h" } : { bold: true };
    // Large item names are double width, so their indent is twice as many printed columns.
    const modIndent = large ? NAME_INDENT * 2 : NAME_INDENT;
    if (qty > 1 && (mods.length > 0 || note)) {
      lines.push(L(" ".repeat(modIndent) + fit(`MAKE ${qty} - EACH WITH:`, "EACH WITH:", cols - modIndent), { bold: true }));
    }
    for (const mod of mods) {
      const { label, price: modPrice } = splitModifierPrice(mod);
      const room = cols - modIndent - 2 - (modPrice ? modPrice.length + 1 : 0);
      const parts = wrap(label, Math.max(8, room));
      parts.forEach((part, i) => {
        const left = `${" ".repeat(modIndent)}${i === 0 ? "- " : "  "}${part}`;
        lines.push(L(i === 0 && modPrice ? pad(left, modPrice, cols) : left, modAttrs));
      });
    }
    // The customer's own words about this item. They used to print as one more ">>" line, wrapped into four,
    // indistinguishable from the sides above them.
    if (note) {
      lines.push(L(" ".repeat(modIndent) + fit("NOTE FOR THIS ITEM:", "NOTE:", cols - modIndent), { bold: true }));
      for (const l of wrap(note, Math.max(8, cols - modIndent - 2))) {
        lines.push(L(`${" ".repeat(modIndent)}  ${l}`, modAttrs));
      }
    }
  });
  lines.push(L(rule));

  // --- The customer's note, with the items (Charlie's 2026-11-12: "larger notes section ... move it to the order
  // section"). It used to print small at the very bottom, under the payment, where a cook building the plate never
  // looks. Same size as the items, under a reversed NOTE bar, before any money.
  const { kitchen: kitchenNote, discount } = splitTicketNotes(cateringText(order.source, order.notes));
  if (kitchenNote) {
    lines.push(L(" NOTE ", { align: "center", bold: true, reverse: true, size: large ? "double" : "double-h" }));
    const noteAttrs: Partial<TicketLine> = large ? { bold: true, size: "double" } : { bold: true, size: "double-h" };
    for (const l of wrap(kitchenNote, W)) lines.push(L(l, noteAttrs));
    lines.push(L(rule));
  }

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
  if (discount) lines.push(L(pad("Discount", discount, cols)));
  // The tip is the DRIVER's money - it prints on its own line, never buried.
  const tip = fmt(order.tip);
  if (tip !== null) lines.push(L(pad("TIP (driver)", tip, cols), { bold: true }));

  const total = fmt(order.customer_total);
  if (total !== null) {
    lines.push(L(rule));
    const totalLine = large ? pad("TOTAL", total, bigCols) : pad("TOTAL", total, cols);
    lines.push(L(totalLine, { bold: true, size: large ? "double" : "double-h" }));
  }
  // A restaurant never sees "ezCater"; stored rows are cleaned here so a reprint matches a new ticket.
  const paymentType = cateringText(order.source, order.payment_type);
  if (paymentType) {
    const tender = String(paymentType);
    // A phone order's payment_type is a whole instruction - "PAID - CARD
    // ****1234" or "CASH DUE $42.10" (lib/phone-order.ts) - and the one line
    // on the ticket that tells the counter whether to collect. It prints as
    // itself, bold. Every other source stores a tender NAME ("CREDIT"), which
    // keeps the "Paid" label it always had.
    if (TENDER_LINE_RE.test(tender)) lines.push(L(tender, { bold: true }));
    else lines.push(L(pad("Paid", tender, cols)));
  }

  // --- Footer --------------------------------------------------------------
  // Whitespace before it on purpose: this is the part a customer keeps, and
  // it has to survive being torn off above the perforation.
  if (opts.omitFooter) return lines;

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

/** "Steamed Broccoli +$4.00" -> the choice and its price, apart, so the price can sit at the right edge. Pure. */
export function splitModifierPrice(mod: string): { label: string; price: string | null } {
  const m = /^(.*\S)\s+(\+\$\d+(?:\.\d{1,2})?)$/.exec(String(mod ?? "").trim());
  return m ? { label: m[1], price: m[2] } : { label: String(mod ?? "").trim(), price: null };
}

/**
 * An item's choices and the customer's own note, apart. The mapper appends the note as the last modifier and
 * (since TK2) also names it in `note`; an order stored before that has no `note` and prints as it always did. Pure.
 */
export function splitItemNote(it: { modifiers?: string[]; note?: string | null } | null | undefined): { mods: string[]; note: string | null } {
  const mods = Array.isArray(it?.modifiers) ? it!.modifiers!.filter((m) => typeof m === "string" && m.trim()) : [];
  const note = typeof it?.note === "string" && it.note.trim() ? it.note.trim() : null;
  if (!note) return { mods, note: null };
  const last = mods.length - 1;
  return { mods: last >= 0 && mods[last].trim() === note ? mods.slice(0, last) : mods, note };
}

/**
 * Pulls a leading quantity out of the item name.
 *
 * The mapper folds quantity into the name ("2x Cheeseburger") because that is
 * what the old single-column layout wanted. Rather than change the canonical
 * shape - which is stored on every existing order and replayed from - the
 * renderer unfolds it, so historic orders reprint correctly too.
 */
/**
 * Exported so the tablet screen reads a quantity the same way the paper does.
 * "2x Burger" meaning two burgers on the ticket and one on the tablet is the
 * kind of disagreement nobody notices until a plate comes back.
 */
export function splitQuantity(rawName: string, it?: { quantity?: number }): { qty: number; name: string } {
  if (typeof it?.quantity === "number" && it.quantity > 0) {
    return { qty: it.quantity, name: rawName };
  }
  const m = /^\s*(\d+)\s*x\s+(.*)$/i.exec(rawName);
  if (m) return { qty: parseInt(m[1], 10), name: m[2] };
  return { qty: 1, name: rawName };
}

/**
 * The CSS classes that carry one ticket line's emphasis onto a screen.
 *
 * Lives here rather than in the component so the public demo page can render
 * a byte-identical ticket without a second copy of these rules. Two renderers
 * drifting apart is how a demo starts showing something the kitchen never
 * sees - see scripts/build-demo.ts.
 */
export function ticketLineClass(l: TicketLine): string {
  const c = ["tl"];
  if (l.bold) c.push("tl-b");
  if (l.reverse) c.push("tl-rev");
  if (l.size === "double") c.push("tl-2x");
  if (l.size === "double-h") c.push("tl-2h");
  if (l.align === "center") c.push("tl-c");
  if (l.align === "right") c.push("tl-r");
  return c.join(" ");
}

export function xmlEscape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The <epos-print> element - embedded in <PrintData> for Server Direct Print. */
export function toEposPrintXml(
  lines: TicketLine[],
  cols = 48,
  opts: { wrap?: boolean } = {}
): string {
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

  // wrap:false returns just the elements, so the caller can sandwich them
  // between raster blocks inside a single <epos-print> document.
  if (opts.wrap === false) return body;
  return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}<feed line="3"/><cut type="feed"/></epos-print>`;
}

/**
 * Renders ticket lines as plain text.
 *
 * For the email delivery leg, where Automatic Email Manager prints whatever
 * arrives. The spec called this renderTicket(); no such function existed -
 * the renderer produced ePOS XML and nothing else - so this is new.
 *
 * Emphasis attributes are dropped rather than simulated. A thermal printer
 * has bold and double-height; a monospace mail body has neither, and markers
 * like **NO ONIONS** would print literally on the kitchen's paper. Layout
 * carries the meaning instead: the modifier arrows and the quantity column
 * survive, which is what a cook actually scans for.
 *
 * Double-width lines are laid out at half the column count, matching what the
 * printer would do, so a large-print restaurant's ticket wraps the same way.
 */
export function toPlainText(lines: TicketLine[], cols = 48): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.qr) {
      // A QR is meaningless in text. The URL is not.
      out.push(line.qr);
      continue;
    }
    const text = line.text ?? "";
    if (!text) { out.push(""); continue; }
    const width = line.size === "double" && text.length <= Math.floor(cols / 2)
      ? Math.floor(cols / 2)
      : cols;
    if (line.align === "center") {
      const pad = Math.max(0, Math.floor((width - text.length) / 2));
      out.push(" ".repeat(pad) + text);
    } else if (line.align === "right") {
      out.push(" ".repeat(Math.max(0, width - text.length)) + text);
    } else {
      out.push(text);
    }
  }
  // Trailing blank lines are the ticket's feed-before-cut; they are noise here.
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}
