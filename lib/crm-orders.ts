import { localDayKey } from "./local-day";
import { isValidTimeZone } from "./clock";
import { orderDestinations } from "./canonical";
import { isLate, isSettled, itemsLine } from "./order-display";
import { countdown, isUnaccepted, prepMinutesOf } from "./countdown";
import { STILL_ACTIONABLE_MS } from "./kiosk";
import { DEFAULT_THRESHOLDS } from "./health";

/**
 * Today's orders, as the CRM sees them (Workstream M1, Nick 2026-09-18).
 *
 * "An area that shows today's orders like an order dashboard - shows the
 * ticket information, can click and open for more information." Who sees
 * it: PFD staff in a browser, not restaurants - so the source IS shown,
 * the full phone is in the detail, and nothing here is softened.
 *
 * The pure half: the local-day window, the row shape, the print state,
 * the flags and the sort. Every flag is computed with the same helper the
 * tablet uses, so the CRM and the kitchen never disagree about whether an
 * order is late. Nothing is fabricated: a field the row does not carry is
 * null, and the phone in a list row is its last four digits only.
 */

export const DEFAULT_ORDERS_TZ = "America/Chicago";
export const ORDERS_LIST_LIMIT = 2000;

/** How long a paper job may sit queued/claimed/held before the list calls it stuck - health's own line. */
export const PRINT_STUCK_MS = DEFAULT_THRESHOLDS.jobPendingMinutes * 60_000;
/** An unaccepted order older than this is flagged - health's order_unaccepted line. */
export const UNACCEPTED_FLAG_MS = DEFAULT_THRESHOLDS.orderUnacceptedMinutes * 60_000;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant a local calendar day begins, and the instant the next one
 * does, in the zone - so `received_at >= start AND < end` is exactly that
 * day's orders. Found by asking the zone rather than by assuming an
 * offset: 2026-11-01 in Chicago is 25 hours long and its midnight is
 * 05:00Z while its noon is 18:00Z, and a fixed offset gets one of those
 * wrong. Null for a date that is not YYYY-MM-DD or a zone Intl does not
 * know.
 */
export function localDayWindow(date: string, tz: string): { start: string; end: string } | null {
  if (!DATE_RE.test(date) || !isValidTimeZone(tz)) return null;
  const start = localMidnightUtc(date, tz);
  if (start === null) return null;
  const next = nextDate(date);
  const end = localMidnightUtc(next, tz);
  if (end === null) return null;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The UTC ms at which `date` starts in `tz`. Guess from the noon offset, then walk to the exact minute. */
function localMidnightUtc(date: string, tz: string): number | null {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Start from the offset the zone has at noon of that date (never inside a
  // US transition, which happen at 2 AM), then correct hour by hour and
  // minute by minute until this instant is the first one on that date.
  const noon = utcMidnight + 12 * 3_600_000;
  let t = utcMidnight - zoneOffsetMs(noon, tz);
  for (let i = 0; i < 6 && localDayKey(t, tz) !== date; i++) t += 3_600_000;
  for (let i = 0; i < 6 && localDayKey(t - 3_600_000, tz) === date; i++) t -= 3_600_000;
  for (let i = 0; i < 60 && localDayKey(t - 60_000, tz) === date; i++) t -= 60_000;
  return localDayKey(t, tz) === date ? t : null;
}

/** The zone's UTC offset at an instant, in ms (Chicago in September: -5h). */
function zoneOffsetMs(at: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The last four digits of a phone, or null. Never the whole number in a list. */
export function phoneLast4(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export type PrintState = "printed" | "queued" | "held" | "failed" | "stuck" | "expired" | "none";

export interface PrintJobRow {
  id: string;
  status: string;
  delivery?: string | null;
  device_id?: string | null;
  queued_at?: string | null;
  claimed_at?: string | null;
  finished_at?: string | null;
  sent_at?: string | null;
  attempts?: number | null;
  error?: string | null;
  send_error?: string | null;
  queued_by?: string | null;
  delivered_count?: number | null;
  device_name?: string | null;
}

export interface PrintSummary {
  state: PrintState;
  job_id: string | null;
  failed_reason: string | null;
}

/** What the paper channel did for an order, from its print jobs (app and email rows are not paper). */
export function printSummary(jobs: PrintJobRow[], now: number): PrintSummary {
  const paper = jobs.filter((j) => (j.delivery ?? "epson") === "epson");
  if (!paper.length) return { state: "none", job_id: null, failed_reason: null };
  const by = (s: string) => paper.find((j) => j.status === s);
  const printed = by("printed");
  if (printed) return { state: "printed", job_id: printed.id, failed_reason: null };
  const failed = paper.find((j) => j.status === "failed" || j.status === "failed_acknowledged");
  if (failed) return { state: "failed", job_id: failed.id, failed_reason: failed.error ?? null };
  const pending = paper.find((j) => j.status === "queued" || j.status === "claimed" || j.status === "held");
  if (pending) {
    const age = pending.queued_at ? now - Date.parse(pending.queued_at) : 0;
    if (age >= PRINT_STUCK_MS) return { state: "stuck", job_id: pending.id, failed_reason: pending.error ?? null };
    return { state: pending.status === "held" ? "held" : "queued", job_id: pending.id, failed_reason: pending.error ?? null };
  }
  const expired = by("expired");
  if (expired) return { state: "expired", job_id: expired.id, failed_reason: expired.error ?? null };
  return { state: "none", job_id: null, failed_reason: null };
}

export interface OrderFlags {
  unaccepted_over_3m: boolean;
  late: boolean;
  overtime: boolean;
}

export interface OrderRowInput {
  id: string;
  order_number: string;
  source: string | null;
  status: string;
  restaurant_id: string;
  received_at: string;
  opened_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  printed_at: string | null;
  updated_at?: string | null;
  due_time: string | null;
  order_type: string | null;
  payment_type: string | null;
  channel_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  items: { name: string; price: string | null; modifiers: string[] }[] | null;
  customer_total: number | string | null;
}

export interface RestaurantRef {
  id: string;
  crm_restaurant_id: string | null;
  name: string | null;
  /** Zuppler's numeric restaurant id - the routing key, and a placeholder in the back-link (lib/zuppler-link.ts). */
  zuppler_restaurant_id?: string | null;
  prep_minutes?: number | null;
  print_method?: string | null;
  app_expected?: boolean | null;
  has_active_printer?: boolean;
}

export interface OrderListRow {
  order_id: string;
  order_number: string;
  source: string | null;
  status: string;
  restaurant: { id: string; crm_restaurant_id: string | null; name: string | null };
  received_at: string;
  opened_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  printed_at: string | null;
  updated_at: string | null;
  due_time: string | null;
  order_type: string | null;
  payment_type: string | null;
  channel_id: string | null;
  customer: { name: string | null; phone_last4: string | null };
  items_line: string;
  item_count: number;
  total: number | null;
  prep_minutes: number;
  destinations: string[];
  print: PrintSummary;
  flags: OrderFlags;
}

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function orderFlags(o: OrderRowInput, prepMinutes: number, now: number): OrderFlags {
  const age = now - Date.parse(o.received_at);
  const unacceptedOpen = isUnaccepted(o as any) && Number.isFinite(age) && age < STILL_ACTIONABLE_MS;
  return {
    unaccepted_over_3m: unacceptedOpen && age >= UNACCEPTED_FLAG_MS,
    late: isLate(o as any, now),
    overtime: countdown(o as any, prepMinutes, now)?.phase === "over",
  };
}

/** One list row. The full phone is deliberately not here. */
export function shapeOrderRow(o: OrderRowInput, r: RestaurantRef, jobs: PrintJobRow[], now: number): OrderListRow {
  const prep = prepMinutesOf(r.prep_minutes);
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    order_id: o.id,
    order_number: o.order_number,
    source: o.source ?? null,
    status: o.status,
    restaurant: { id: r.id, crm_restaurant_id: r.crm_restaurant_id ?? null, name: r.name ?? null },
    received_at: o.received_at,
    opened_at: o.opened_at ?? null,
    accepted_at: o.accepted_at ?? null,
    completed_at: o.completed_at ?? null,
    cancelled_at: o.cancelled_at ?? null,
    printed_at: o.printed_at ?? null,
    updated_at: o.updated_at ?? null,
    due_time: o.due_time ?? null,
    order_type: o.order_type ?? null,
    payment_type: o.payment_type ?? null,
    channel_id: o.channel_id ?? null,
    customer: { name: o.customer_name ?? null, phone_last4: phoneLast4(o.customer_phone) },
    items_line: itemsLine(items, 3),
    item_count: items.length,
    total: num(o.customer_total),
    prep_minutes: prep,
    destinations: orderDestinations({
      print_method: r.print_method ?? null,
      app_expected: r.app_expected ?? null,
      hasActivePrinter: r.has_active_printer ?? false,
    }),
    print: printSummary(jobs, now),
    flags: orderFlags(o, prep, now),
  };
}

/**
 * The list's order, the same one the tablet uses: unaccepted first (oldest
 * first), then in the kitchen by least time remaining, then settled -
 * completed or cancelled - newest first.
 */
export function sortOrderRows<T extends OrderListRow>(rows: T[], now: number): T[] {
  const open = rows.filter((r) => !isSettled(r as any));
  const settled = rows.filter((r) => isSettled(r as any));
  // kitchenSort reads prep_minutes per row through the countdown; rows can
  // come from different restaurants, so sort each by its own target.
  const openSorted = kitchenSortMixed(open, now);
  settled.sort((a, b) => {
    const ta = a.completed_at ?? a.cancelled_at ?? a.received_at;
    const tb = b.completed_at ?? b.cancelled_at ?? b.received_at;
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  return [...openSorted, ...settled];
}

/**
 * kitchenSort's rule (lib/countdown.ts) applied across restaurants: each
 * row's countdown runs from its own restaurant's prep target, which the
 * tablet's single-restaurant sort never has to think about. Asserted equal
 * to kitchenSort for one restaurant in scripts/test-crm-orders.ts.
 */
function kitchenSortMixed<T extends OrderListRow>(rows: T[], now: number): T[] {
  const unaccepted = rows.filter((r) => isUnaccepted(r as any)).sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));
  const accepted = rows
    .filter((r) => !isUnaccepted(r as any))
    .map((r) => ({ r, remaining: countdown(r as any, r.prep_minutes, now)?.remainingMs ?? Infinity }))
    .sort((a, b) => a.remaining - b.remaining)
    .map((x) => x.r);
  return [...unaccepted, ...accepted];
}

export interface OrderCounts {
  total: number;
  unaccepted: number;
  in_kitchen: number;
  completed: number;
  cancelled: number;
  unprinted: number;
  test: number;
}

export function orderCounts(rows: OrderListRow[]): OrderCounts {
  const settled = (r: OrderListRow) => r.status === "completed" || r.status === "cancelled";
  return {
    total: rows.length,
    unaccepted: rows.filter((r) => !settled(r) && !r.accepted_at).length,
    in_kitchen: rows.filter((r) => !settled(r) && Boolean(r.accepted_at)).length,
    completed: rows.filter((r) => r.status === "completed").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    // Meant to print (a printer destination) and no ticket has come out.
    unprinted: rows.filter((r) => r.destinations.includes("printer") && r.print.state !== "printed" && r.status !== "cancelled").length,
    test: rows.filter((r) => r.source === "test").length,
  };
}

/** Rows changed after `since` (updated_at, migration 039). Rows without one are always included - they cannot prove they did not change. */
export function changedSince<T extends { updated_at: string | null }>(rows: T[], since: string | null): T[] {
  if (!since) return rows;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return rows;
  return rows.filter((r) => !r.updated_at || Date.parse(r.updated_at) > t);
}

export interface TimelineEntry {
  at: string;
  event: "received" | "printed" | "opened" | "accepted" | "completed" | "cancelled" | "print_attempt";
  detail: string | null;
}

/** The order's life in order, from its timestamps and its print jobs. */
export function orderTimeline(o: OrderRowInput, jobs: PrintJobRow[]): TimelineEntry[] {
  const out: TimelineEntry[] = [{ at: o.received_at, event: "received", detail: null }];
  for (const j of jobs) {
    if ((j.delivery ?? "epson") !== "epson") continue;
    const at = j.finished_at ?? j.claimed_at ?? j.queued_at;
    if (!at) continue;
    const who = j.device_name ? ` on ${j.device_name}` : "";
    const detail =
      j.status === "printed"
        ? `printed${who}`
        : `${j.status}${who}${j.error ? ` - ${j.error}` : ""}${j.queued_by ? ` (${j.queued_by})` : ""}`;
    out.push({ at, event: j.status === "printed" ? "printed" : "print_attempt", detail });
  }
  if (o.opened_at) out.push({ at: o.opened_at, event: "opened", detail: null });
  if (o.accepted_at) out.push({ at: o.accepted_at, event: "accepted", detail: null });
  if (o.completed_at) out.push({ at: o.completed_at, event: "completed", detail: null });
  if (o.cancelled_at) out.push({ at: o.cancelled_at, event: "cancelled", detail: null });
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export interface AppDelivery {
  pushed: boolean;
  at: string | null;
  devices_reached: number | null;
  error: string | null;
}

/** Whether the tablet was told, from the order's app job (one per order). */
export function appDelivery(jobs: PrintJobRow[]): AppDelivery | null {
  const app = jobs.find((j) => j.delivery === "app");
  if (!app) return null;
  return {
    pushed: Boolean(app.sent_at) && (app.delivered_count ?? 0) > 0,
    at: app.sent_at ?? null,
    devices_reached: app.delivered_count ?? null,
    error: app.send_error ?? null,
  };
}

/** The action verbs the CRM may send, and what each refuses. */
export type OrderAction = "reprint" | "resend_app";
export const ORDER_ACTIONS: readonly OrderAction[] = ["reprint", "resend_app"];
export const isOrderAction = (v: unknown): v is OrderAction => ORDER_ACTIONS.includes(v as OrderAction);
