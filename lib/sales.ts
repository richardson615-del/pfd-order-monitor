/**
 * Sales: what the restaurant sold, for any range of days (PA6, 2026-10-27).
 *
 * Chef's Market asked to see every transaction as it happens after an item
 * went through uncharged, and Matt asked for "any other tracking or
 * transactions they would want, easy to use and not cluttered". This is the
 * one place that decides what a range of orders adds up to; the web Sales
 * tab, the PFD Partner app and the CSV export all read it.
 *
 * Pure: the route fetches, this decides. Money is added in cents so a month
 * of orders cannot drift by a cent. Days are the restaurant's own days
 * (lib/local-day.ts), like Past week.
 *
 * What counts: the same rule as Past week (countsForHistory). A cancelled
 * order is listed, struck through, and totalled on its own line; a test
 * order is never shown.
 *
 * Numbers a restaurant reads:
 *  - Food sales: the items, after any discount. What the kitchen sold.
 *  - Customers paid: the order totals, the way the customer's receipt reads.
 *  - Tax, delivery and service fees, tips: the parts of that total that are
 *    not food.
 * The card surcharge on phone orders is PFD's money and ezCater's fee is
 * ezCater's; neither is the restaurant's sale, so neither is shown as one.
 */
import type { Order, OrderItem } from "./types";
import { countsForHistory } from "./history";
import { dayLabel, localDayKey, timeLabel } from "./local-day";

/** The longest range one request may ask for. A year covers any tax question. */
export const SALES_MAX_DAYS = 366;
/** More orders than this in one range and the list is cut (`truncated`); the totals say so too. */
export const SALES_ORDER_CAP = 5000;
/** Best sellers shown. */
export const TOP_ITEMS = 5;

/** The columns the sales routes read. Nothing about the customer beyond their name. */
export const SALES_COLUMNS =
  "id, order_number, order_type, source, customer_name, items, line_items, items_total, tax, service_fee, delivery_fee, tip, discount, customer_total, payment_type, status, received_at, cancelled_at";

export interface SalesLineItem {
  name: string;
  quantity: number;
  item_total: number | null;
}

export type SalesOrder = Pick<
  Order,
  | "id"
  | "order_number"
  | "order_type"
  | "source"
  | "customer_name"
  | "items"
  | "items_total"
  | "tax"
  | "service_fee"
  | "delivery_fee"
  | "tip"
  | "discount"
  | "customer_total"
  | "payment_type"
  | "status"
  | "received_at"
  | "cancelled_at"
> & { line_items?: SalesLineItem[] | null };

export interface SalesRange {
  from: string;
  to: string;
}

export interface SalesTotals {
  /** Orders that count (not cancelled, not test). */
  orders: number;
  /** Food sales in cents: items_total less discount. */
  food_cents: number;
  /** What customers paid in cents: customer_total. */
  paid_cents: number;
  tax_cents: number;
  /** Delivery and service fees together. */
  fees_cents: number;
  tip_cents: number;
  discount_cents: number;
  /** Average customer total in cents, 0 with no orders. */
  average_cents: number;
  cancelled: { orders: number; paid_cents: number };
  /** Orders with an item that came through with no price. */
  to_check: number;
}

export interface SalesDay {
  key: string;
  label: string;
  orders: number;
  paid_cents: number;
}

export interface SalesGroup {
  label: string;
  orders: number;
  paid_cents: number;
}

export interface SalesItem {
  name: string;
  quantity: number;
}

/** One row in the list: enough to find the order, never the address or phone. */
export interface SalesRow {
  id: string;
  order_number: string;
  day: string;
  time: string;
  channel: string;
  order_type: "pickup" | "delivery" | null;
  customer: string | null;
  paid_cents: number | null;
  cancelled: boolean;
  /** Plain words, e.g. "An item came through with no price". Empty = nothing to check. */
  checks: string[];
}

export interface SalesReport {
  range: SalesRange;
  timezone: string | null;
  totals: SalesTotals;
  days: SalesDay[];
  channels: SalesGroup[];
  payments: SalesGroup[];
  top_items: SalesItem[];
  rows: SalesRow[];
  truncated: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600_000;

/** Dollars (numeric column, may arrive as a string) to whole cents; null when absent. */
export function toCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "$1,234.50" from cents; "-$3.00" for a negative. */
export function centsLabel(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Where the order came from, in the words a restaurant uses. */
export function channelLabel(source: Order["source"] | null | undefined): string {
  switch (source) {
    case "zuppler":
    case "email":
      return "Online";
    case "phone":
      return "Phone";
    case "ezcater":
      return "ezCater";
    case "ubereats":
      return "Uber Eats";
    default:
      return "Other";
  }
}

/** The payment type as written, tidied: "credit_card" -> "Card", blank -> "Not given". */
export function paymentLabel(p: string | null | undefined): string {
  const s = (p ?? "").trim().toLowerCase();
  if (!s) return "Not given";
  if (/card|credit|debit|visa|master|amex|discover|stripe|helcim|braintree/.test(s)) return "Card";
  if (/cash/.test(s)) return "Cash";
  if (/check/.test(s)) return "Check";
  if (/invoice|account|house/.test(s)) return "On account";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

/**
 * An item that came through with no price. On a ticket a missing price is
 * easy to miss; in a day's takings it is money the restaurant never
 * charged (Chef's Market, 2026-10-26). A $0 line that says "no charge" or
 * "free", or a modifier line, is not flagged.
 */
export function unpricedItems(items: OrderItem[] | null | undefined): string[] {
  const out: string[] = [];
  for (const it of items ?? []) {
    if (!it || typeof it.name !== "string") continue;
    if (/\b(free|no charge|n\/c|comp)\b/i.test(it.name)) continue;
    const c = toCents(it.price);
    if (c === null || c === 0) out.push(it.name.trim());
  }
  return out;
}

/** What to check on one order, in plain words. */
export function orderChecks(o: Pick<SalesOrder, "items" | "items_total" | "status" | "source">): string[] {
  if (!countsForHistory(o)) return [];
  const unpriced = unpricedItems(o.items);
  const checks: string[] = [];
  if (unpriced.length === 1) checks.push(`No price on ${unpriced[0]}`);
  else if (unpriced.length > 1) checks.push(`No price on ${unpriced.length} items`);
  return checks;
}

/**
 * The range a request asked for, or why not. Both ends are the restaurant's
 * own days, inclusive. Missing ends default to today.
 */
export function parseSalesRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: number,
  timezone: string | null | undefined
): { ok: true; range: SalesRange } | { ok: false; error: string } {
  const today = localDayKey(now, timezone);
  const f = (from ?? "").trim() || today;
  const t = (to ?? "").trim() || today;
  if (!DATE_RE.test(f) || !DATE_RE.test(t)) return { ok: false, error: "from and to must be dates like 2026-10-27" };
  const real = (k: string) => {
    const ms = Date.parse(`${k}T12:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === k;
  };
  if (!real(f) || !real(t)) return { ok: false, error: "That date does not exist" };
  if (f > t) return { ok: false, error: "The start date is after the end date" };
  if (dayCount({ from: f, to: t }) > SALES_MAX_DAYS) return { ok: false, error: `Pick ${SALES_MAX_DAYS} days or fewer` };
  return { ok: true, range: { from: f, to: t } };
}

/** Days in the range, inclusive. */
export function dayCount(r: SalesRange): number {
  return Math.round((Date.parse(`${r.to}T12:00:00Z`) - Date.parse(`${r.from}T12:00:00Z`)) / DAY_MS) + 1;
}

/** Every day key in the range, oldest first. */
export function rangeDayKeys(r: SalesRange): string[] {
  const keys: string[] = [];
  const start = Date.parse(`${r.from}T12:00:00Z`);
  for (let i = 0; i < dayCount(r); i++) keys.push(new Date(start + i * DAY_MS).toISOString().slice(0, 10));
  return keys;
}

/**
 * The UTC window to query: a day of slack either side so no zone offset or
 * DST change can lose an edge order. salesReport keeps only the range's own
 * local days.
 */
export function salesQueryWindow(r: SalesRange): { since: string; until: string } {
  return {
    since: new Date(Date.parse(`${r.from}T00:00:00Z`) - DAY_MS).toISOString(),
    until: new Date(Date.parse(`${r.to}T00:00:00Z`) + 2 * DAY_MS).toISOString(),
  };
}

const n0 = (c: number | null) => c ?? 0;

/** Best sellers by quantity: structured line items when the order has them, otherwise one per ticket line. */
function addItems(tally: Map<string, SalesItem>, o: SalesOrder) {
  const lines: { name: string; quantity: number }[] =
    Array.isArray(o.line_items) && o.line_items.length
      ? o.line_items.map((l) => ({ name: String(l.name ?? "").trim(), quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1 }))
      : (o.items ?? []).map((it) => {
          const m = /^\s*(\d+)\s*x\s+(.+)$/i.exec(it.name ?? "");
          return m ? { name: m[2].trim(), quantity: Number(m[1]) } : { name: String(it.name ?? "").trim(), quantity: 1 };
        });
  for (const l of lines) {
    if (!l.name) continue;
    const key = l.name.toLowerCase();
    const cur = tally.get(key) ?? { name: l.name, quantity: 0 };
    cur.quantity += l.quantity;
    tally.set(key, cur);
  }
}

function addGroup(groups: Map<string, SalesGroup>, label: string, paid: number) {
  const g = groups.get(label) ?? { label, orders: 0, paid_cents: 0 };
  g.orders += 1;
  g.paid_cents += paid;
  groups.set(label, g);
}

const byPaidDesc = (a: SalesGroup, b: SalesGroup) => b.paid_cents - a.paid_cents || b.orders - a.orders || a.label.localeCompare(b.label);

/**
 * The report for a range. `orders` may hold anything from the query window;
 * anything outside the range's local days, and every test order, is dropped.
 * `truncated` is the route's word that the query hit its cap.
 */
export function salesReport(
  orders: SalesOrder[],
  range: SalesRange,
  now: number,
  timezone: string | null | undefined,
  truncated = false
): SalesReport {
  const keys = rangeDayKeys(range);
  const inRange = new Set(keys);
  const days = new Map<string, SalesDay>(keys.map((k) => [k, { key: k, label: dayLabel(k, now, timezone), orders: 0, paid_cents: 0 }]));
  const channels = new Map<string, SalesGroup>();
  const payments = new Map<string, SalesGroup>();
  const items = new Map<string, SalesItem>();
  const totals: SalesTotals = {
    orders: 0,
    food_cents: 0,
    paid_cents: 0,
    tax_cents: 0,
    fees_cents: 0,
    tip_cents: 0,
    discount_cents: 0,
    average_cents: 0,
    cancelled: { orders: 0, paid_cents: 0 },
    to_check: 0,
  };
  const rows: SalesRow[] = [];

  const sorted = [...orders].sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
  for (const o of sorted) {
    if (o.source === "test") continue;
    const key = localDayKey(o.received_at, timezone);
    if (!inRange.has(key)) continue;
    const paid = toCents(o.customer_total);
    const cancelled = o.status === "cancelled";
    const checks = orderChecks(o);
    rows.push({
      id: o.id,
      order_number: o.order_number,
      day: key,
      time: timeLabel(o.received_at, timezone),
      channel: channelLabel(o.source),
      order_type: o.order_type ?? null,
      customer: firstName(o.customer_name),
      paid_cents: paid,
      cancelled,
      checks,
    });
    if (cancelled) {
      totals.cancelled.orders += 1;
      totals.cancelled.paid_cents += n0(paid);
      continue;
    }
    const discount = Math.abs(n0(toCents(o.discount)));
    totals.orders += 1;
    totals.paid_cents += n0(paid);
    totals.food_cents += n0(toCents(o.items_total)) - discount;
    totals.discount_cents += discount;
    totals.tax_cents += n0(toCents(o.tax));
    totals.fees_cents += n0(toCents(o.delivery_fee)) + n0(toCents(o.service_fee));
    totals.tip_cents += n0(toCents(o.tip));
    if (checks.length) totals.to_check += 1;
    const d = days.get(key)!;
    d.orders += 1;
    d.paid_cents += n0(paid);
    addGroup(channels, channelLabel(o.source), n0(paid));
    addGroup(payments, paymentLabel(o.payment_type), n0(paid));
    addItems(items, o);
  }
  totals.average_cents = totals.orders ? Math.round(totals.paid_cents / totals.orders) : 0;

  return {
    range,
    timezone: timezone ?? null,
    totals,
    days: keys.map((k) => days.get(k)!),
    channels: [...channels.values()].sort(byPaidDesc),
    payments: [...payments.values()].sort(byPaidDesc),
    top_items: [...items.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)).slice(0, TOP_ITEMS),
    rows,
    truncated,
  };
}

/** First name only: a sales list is read over a counter, not a delivery sheet. */
export function firstName(name: string | null | undefined): string | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  return s.split(/\s+/)[0];
}

/** One order, broken down the way a receipt reads (the app's and the web's order view). */
export interface SalesReceipt {
  id: string;
  order_number: string;
  day: string;
  time: string;
  channel: string;
  order_type: "pickup" | "delivery" | null;
  customer: string | null;
  payment: string;
  cancelled: boolean;
  items: { name: string; price_cents: number | null; modifiers: string[]; unpriced: boolean }[];
  lines: { label: string; cents: number }[];
  paid_cents: number | null;
  checks: string[];
}

export function salesReceipt(o: SalesOrder, timezone: string | null | undefined): SalesReceipt {
  const unpriced = new Set(unpricedItems(o.items));
  const line = (label: string, v: unknown, negative = false): { label: string; cents: number } | null => {
    const c = toCents(v);
    if (c === null || c === 0) return null;
    return { label, cents: negative ? -Math.abs(c) : c };
  };
  return {
    id: o.id,
    order_number: o.order_number,
    day: localDayKey(o.received_at, timezone),
    time: timeLabel(o.received_at, timezone),
    channel: channelLabel(o.source),
    order_type: o.order_type ?? null,
    customer: firstName(o.customer_name),
    payment: paymentLabel(o.payment_type),
    cancelled: o.status === "cancelled",
    items: (o.items ?? []).map((it) => ({
      name: it.name,
      price_cents: toCents(it.price),
      modifiers: Array.isArray(it.modifiers) ? it.modifiers : [],
      unpriced: unpriced.has((it.name ?? "").trim()),
    })),
    lines: [
      line("Items", o.items_total),
      line("Discount", o.discount, true),
      line("Tax", o.tax),
      line("Service fee", o.service_fee),
      line("Delivery fee", o.delivery_fee),
      line("Tip", o.tip),
    ].filter((l): l is { label: string; cents: number } => l !== null),
    paid_cents: toCents(o.customer_total),
    checks: orderChecks(o),
  };
}

/** A CSV cell: quoted when it needs to be, and never read as a formula by a spreadsheet. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (c: number | null): string => (c === null ? "" : (c / 100).toFixed(2));

export const SALES_CSV_HEADER = [
  "Date",
  "Time",
  "Order",
  "Channel",
  "Type",
  "Customer",
  "Items",
  "Item sales",
  "Discount",
  "Tax",
  "Service fee",
  "Delivery fee",
  "Tip",
  "Total",
  "Payment",
  "Status",
  "Check",
];

/** One line per order, every order in the range including cancelled, oldest first (how a bookkeeper reads it). */
export function salesCsv(orders: SalesOrder[], range: SalesRange, timezone: string | null | undefined): string {
  const inRange = new Set(rangeDayKeys(range));
  const rows = [...orders]
    .filter((o) => o.source !== "test" && inRange.has(localDayKey(o.received_at, timezone)))
    .sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0))
    .map((o) =>
      [
        localDayKey(o.received_at, timezone),
        timeLabel(o.received_at, timezone),
        o.order_number,
        channelLabel(o.source),
        o.order_type ?? "",
        firstName(o.customer_name) ?? "",
        (o.items ?? []).map((it) => `${it.name}${it.price ? ` ${it.price}` : " (no price)"}`).join("; "),
        dollars(toCents(o.items_total)),
        dollars(toCents(o.discount) === null ? null : -Math.abs(toCents(o.discount)!)),
        dollars(toCents(o.tax)),
        dollars(toCents(o.service_fee)),
        dollars(toCents(o.delivery_fee)),
        dollars(toCents(o.tip)),
        dollars(toCents(o.customer_total)),
        paymentLabel(o.payment_type),
        o.status === "cancelled" ? "Cancelled" : "",
        orderChecks(o).join("; "),
      ]
        .map(csvCell)
        .join(",")
    );
  return [SALES_CSV_HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}

/** The file name for a range: sales-2026-10-01-to-2026-10-27.csv. */
export const salesCsvName = (r: SalesRange): string => (r.from === r.to ? `sales-${r.from}.csv` : `sales-${r.from}-to-${r.to}.csv`);
