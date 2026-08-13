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
}

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

export function buildTicket(order: TicketOrder, cols = 48): TicketLine[] {
  const rule = "-".repeat(cols);
  const lines: TicketLine[] = [];

  lines.push(L(order.ticket_restaurant_name || "PFD ORDER", { align: "center", size: "double", bold: true }));
  lines.push(L(`${(order.order_type || "order").toUpperCase()}  -  via ${order.source === "zuppler" ? "ZUPPLER" : "EMAIL"}`, { align: "center" }));
  lines.push(L(rule));
  lines.push(L(`ORDER #${order.order_number ?? "?"}`, { align: "center", size: "double", bold: true }));

  const due = localTime(order.due_time);
  if (due) lines.push(L(`DUE: ${due}`, { align: "center", bold: true }));
  const recv = localTime(order.received_at);
  if (recv) lines.push(L(`received ${recv}`, { align: "center" }));
  lines.push(L(rule));

  if (order.customer_name) lines.push(L(order.customer_name, { bold: true }));
  if (order.customer_phone) lines.push(L(order.customer_phone));
  if (order.customer_address) for (const l of wrap(order.customer_address, cols)) lines.push(L(l));
  if (order.customer_name || order.customer_phone || order.customer_address) lines.push(L(rule));

  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) lines.push(L("(no itemization available)"));
  for (const it of items) {
    const price = typeof it?.price === "string" ? it.price : fmt(it?.price);
    const nameCols = price ? cols - price.length - 1 : cols;
    const wrapped = wrap(it?.name ?? "Item", nameCols);
    lines.push(L(pad(wrapped[0], price ?? "", cols), { bold: true }));
    for (const extra of wrapped.slice(1)) lines.push(L(extra, { bold: true }));
    for (const mod of it?.modifiers ?? []) {
      // Wrap to the indented width, then indent - otherwise the line overflows
      // the paper by exactly the indent.
      for (const l of wrap(`* ${mod}`, cols - 2)) lines.push(L(`  ${l}`));
    }
  }
  lines.push(L(rule));

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

  return lines;
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
      const t = line.text ?? "";
      // Double WIDTH halves the usable columns, so a long line would run off
      // the paper. Fall back to double height rather than clipping it.
      const dbl = line.size === "double" && t.length <= Math.floor(cols / 2);
      const w = dbl ? 2 : 1;
      const h = line.size === "double" || line.size === "double-h" ? 2 : 1;
      const align = line.align === "center" ? "center" : line.align === "right" ? "right" : "left";
      return `<text align="${align}" em="${line.bold ? "true" : "false"}" width="${w}" height="${h}">${xmlEscape(t)}&#10;</text>`;
    })
    .join("");

  return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${body}<feed line="3"/><cut type="feed"/></epos-print>`;
}
