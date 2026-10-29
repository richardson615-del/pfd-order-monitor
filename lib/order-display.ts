/**
 * What an order looks like on the tablet.
 *
 * Pure functions, separate from the card that renders them, because these are
 * the decisions worth testing: which list an order is in, when it starts
 * reading as late, and what a row says about itself. Both display modes call
 * the same ones - kitchen and standard differ in size and loudness, never in
 * what they claim.
 *
 * THE MODEL, since 2026-09-16 (Workstream I2, Nick's decisions):
 *
 *   Two lists and one action. "Orders" is everything in the kitchen today;
 *   "Completed" is what was finished today; the one thing anybody does to a
 *   ticket is press Done. There is no Accept step. Opening a ticket is the
 *   acknowledgement - it stops the chime, and it is recorded as accepted_at
 *   too, so the office's "nobody has looked at this order" alarm keeps its
 *   meaning ("When the ticket is opened treat that as accepted" - Nick).
 *
 *   An order leaves the Orders list six hours after it was received - the
 *   same window the chime stops at (STILL_ACTIONABLE_MS); past it nobody is
 *   going to cook it. It is not marked completed when it ages out: it
 *   simply stops being in the kitchen, and Past week shows it with whatever
 *   status it has, "not marked done". Nothing here fabricates a completion.
 *
 * The database statuses are untouched. Printing and accounting read them,
 * and the README's rule stands: orders.status semantics are not this
 * screen's to change. This file only decides how to SHOW them.
 */
import { Order } from "./types";
import { STILL_ACTIONABLE_MS } from "./kiosk";
import { isSameLocalDay, localDayKey, timeLabel } from "./local-day";
import { effectiveTimeZone } from "./clock";

/**
 * Scheduled orders (SC1, Nick 2026-10-29, Willie Mae's ezCater #GJ3P08).
 *
 * A catering order reaches the kitchen kitchen_lead_hours (default 24 h)
 * before it is due, and every clock on the tablet used to run from that
 * arrival: by morning the card read red and late, and six hours in it fell
 * off the Orders list altogether, ~18 h before anybody was meant to cook it.
 *
 * So an order due more than SCHEDULED_AHEAD_MS from now is SCHEDULED: it
 * still chimes on arrival and Accept still acknowledges it, but it shows
 * "Due Tomorrow 11:30 AM" instead of an age, is never late, has no prep
 * countdown, sorts after today's work, and stays in Orders until it is due.
 * SCHEDULED_AHEAD_MS before it is due it becomes an ordinary kitchen order,
 * with its age counted from then (kitchenClockStart), not from a day ago.
 *
 * Any source: ezCater is the only one that sends orders this far ahead today.
 */
export const SCHEDULED_AHEAD_MS = 2 * 60 * 60 * 1000;

type DueFields = { due_time?: string | null };

const dueMsOf = (order: DueFields): number | null => {
  const t = Date.parse(order.due_time ?? "");
  return Number.isNaN(t) ? null : t;
};

/** It came in more than SCHEDULED_AHEAD_MS before it was due - a scheduled order, now or earlier. */
export function arrivedAhead(order: Pick<Order, "received_at"> & DueFields): boolean {
  const due = dueMsOf(order);
  const received = Date.parse(order.received_at ?? "");
  return due !== null && !Number.isNaN(received) && received < due - SCHEDULED_AHEAD_MS;
}

/** Due far enough off that nobody should be cooking it yet. Settled orders and unreadable due times never are. */
export function isScheduled(order: Pick<Order, "status"> & DueFields, now: number): boolean {
  if (SETTLED.has(order.status)) return false;
  const due = dueMsOf(order);
  return due !== null && due - now > SCHEDULED_AHEAD_MS;
}

/**
 * When the kitchen's clock starts: received_at for an ordinary order, and
 * SCHEDULED_AHEAD_MS before it is due for one that arrived ahead - so a
 * catering order turns into a normal kitchen order two hours before
 * hand-off rather than with twenty-two hours of "age".
 */
export function kitchenClockStart(order: Pick<Order, "received_at"> & DueFields): string | null {
  if (!arrivedAhead(order)) return order.received_at ?? null;
  return new Date((dueMsOf(order) as number) - SCHEDULED_AHEAD_MS).toISOString();
}

/** "Today 11:30 AM", "Tomorrow 11:30 AM", or "Fri, Oct 30 · 11:30 AM", in the restaurant's zone. "" when unreadable. */
export function dueLabel(dueTime: string | null | undefined, now: number, timezone: string | null | undefined): string {
  const due = Date.parse(dueTime ?? "");
  if (Number.isNaN(due)) return "";
  const time = timeLabel(due, timezone);
  const key = localDayKey(due, timezone);
  if (key === localDayKey(now, timezone)) return `Today ${time}`;
  // 24 or 25 h on: one of them is tomorrow even across a DST change.
  if (key === localDayKey(now + 24 * 3600_000, timezone) || key === localDayKey(now + 23 * 3600_000, timezone)) return `Tomorrow ${time}`;
  const day = new Date(due).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: effectiveTimeZone(timezone) });
  return `${day} · ${time}`;
}

/**
 * When an order in the kitchen starts reading as late.
 *
 * Five minutes amber, ten minutes red. Not arbitrary: the order-undelivered
 * alert in lib/health.ts fires at five minutes, so amber appears on the screen
 * at the same moment the office would be told something is wrong. A kitchen
 * that has already gone amber is a kitchen where the text that follows makes
 * sense rather than arriving out of nowhere.
 */
export const AGE_WARN_MS = 5 * 60_000;
export const AGE_LATE_MS = 10 * 60_000;

/** Statuses where nothing is owed - the order is done or was cancelled. */
const SETTLED = new Set(["completed", "cancelled"]);

/**
 * True once nobody in the kitchen needs to act on this order.
 *
 * Completed or cancelled - and nothing else. It used to include "accepted",
 * back when Accept was a step: agreeing to cook silenced the chime and
 * turned the rail green. Now opening is the acknowledgement and the order
 * stays in the kitchen, still ageing, until Done. A ticket somebody opened
 * eleven minutes ago and has not finished is still eleven minutes old.
 */
export function isSettled(order: Pick<Order, "status">): boolean {
  return SETTLED.has(order.status);
}

/**
 * Nobody here has ACCEPTED it yet. This is the NEW pill, and it is what
 * the chime sounds for (see unaccepted() in lib/kiosk.ts). Opening the
 * ticket does not clear it (I3, Nick 2026-09-17): a look is not "we've
 * got it". Kept under its old name so nothing that reads it has to move.
 */
export function isUnopened(order: Pick<Order, "status" | "opened_at" | "accepted_at">): boolean {
  return !isSettled(order) && !order.accepted_at;
}

/** Which of the tablet's lists an order belongs to, today. */
export type Bucket = "orders" | "completed" | "past";

/**
 * Orders = in the kitchen: not settled, and received within the last six
 * hours. Completed = finished today, or cancelled today (restaurant time)
 * - a cancellation is shown, struck through, rather than vanishing, so
 * nobody wonders where the ticket went. Everything else is history, and
 * Past week's.
 *
 * Six hours for the kitchen because that is the chime's window: an order
 * the tablet has stopped ringing for is an order nobody is going to cook,
 * and a list that keeps it is a list that teaches the room to ignore the
 * top of it. "Today" for Completed is the restaurant's day: 11:50 last
 * night is yesterday's business at 8 this morning.
 */
export function bucketOf(
  order: Pick<Order, "status" | "received_at" | "completed_at" | "cancelled_at"> & DueFields,
  now: number,
  timezone: string | null | undefined
): Bucket {
  if (!isSettled(order)) {
    // SC1: a scheduled order is in the kitchen from when it arrives until
    // STILL_ACTIONABLE_MS after it is due - never aged out before its day.
    if (arrivedAhead(order)) return now < (dueMsOf(order) as number) + STILL_ACTIONABLE_MS ? "orders" : "past";
    const age = ageMs(order, now);
    return age !== null && age < STILL_ACTIONABLE_MS ? "orders" : "past";
  }
  const settledAt =
    (order.status === "completed" ? order.completed_at : order.cancelled_at) ?? order.received_at;
  return isSameLocalDay(settledAt, now, timezone) ? "completed" : "past";
}

export const inKitchen = (
  order: Pick<Order, "status" | "received_at" | "completed_at" | "cancelled_at"> & DueFields,
  now: number,
  timezone: string | null | undefined
): boolean => bucketOf(order, now, timezone) === "orders";

export const completedToday = (
  order: Pick<Order, "status" | "received_at" | "completed_at" | "cancelled_at"> & DueFields,
  now: number,
  timezone: string | null | undefined
): boolean => bucketOf(order, now, timezone) === "completed";

/**
 * How old the order is, in ms, or null if we cannot tell.
 *
 * received_at is Zuppler's own timestamp rather than when we ingested it, so
 * this is how long the CUSTOMER has been waiting, which is the number that
 * matters in a kitchen.
 *
 * SC1: counted from kitchenClockStart, so a scheduled order is 0 until two
 * hours before it is due.
 */
export function ageMs(order: Pick<Order, "received_at"> & DueFields, now: number): number | null {
  const start = kitchenClockStart(order);
  if (!start) return null;
  const t = new Date(start).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now - t);
}

/** Whether an order in the kitchen has crossed the late line. A scheduled order never has. */
export function isLate(order: Pick<Order, "status" | "received_at"> & DueFields, now: number): boolean {
  if (isSettled(order) || isScheduled(order, now)) return false;
  const age = ageMs(order, now);
  return age !== null && age >= AGE_LATE_MS && age < STILL_ACTIONABLE_MS;
}

/**
 * The class that drives the urgency rail and the timer colour.
 *
 * A settled order is never late however old it is: an order from this morning
 * that was cooked and completed is history, not a problem, and colouring it
 * red would teach the kitchen that red means nothing.
 *
 * Nor is an order that has sat in the kitchen past the chime window. It is
 * still today's and still on the list - but red and breathing for something
 * from breakfast is the same lesson: it teaches the room that red is
 * background. Those go muted, with the age still on them.
 */
export function ageClass(
  order: Pick<Order, "status" | "received_at"> & DueFields,
  now: number
): "settled" | "age-calm" | "age-warn" | "age-late" | "age-stale" {
  if (isSettled(order)) return "settled";
  if (isScheduled(order, now)) return "age-calm";
  const age = ageMs(order, now);
  if (age === null) return "age-calm";
  if (age >= STILL_ACTIONABLE_MS) return "age-stale";
  if (age >= AGE_LATE_MS) return "age-late";
  if (age >= AGE_WARN_MS) return "age-warn";
  return "age-calm";
}

/**
 * The timer text.
 *
 * Counting UP from when the order arrived, not down to a due time. A count-up
 * needs no configuration to be correct and cannot be wrong about a due time
 * the restaurant never set; and "9:12 and climbing" is the thing somebody
 * standing in a kitchen can act on.
 *
 * m:ss under an hour, because the seconds are what make it read as live.
 */
export function elapsedLabel(order: Pick<Order, "received_at"> & DueFields, now: number): string {
  const age = ageMs(order, now);
  if (age === null) return "";
  const totalSeconds = Math.floor(age / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours >= 1) {
    const mins = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export interface OrderFlag {
  label: string;
  tone: "new" | "done" | "cancelled";
}

/**
 * What the pill on a row says - or null when there is nothing to say.
 *
 * NEW until somebody taps Accept; nothing at all from this function while
 * it is being cooked (the card shows the countdown instead, lib/countdown.ts);
 * Completed or Cancelled once settled. No "Printed": paper is a fact about
 * the paper channel, which the tablet does not report on.
 */
export function orderFlag(order: Pick<Order, "status" | "opened_at" | "accepted_at">): OrderFlag | null {
  if (order.status === "cancelled") return { label: "Cancelled", tone: "cancelled" };
  if (order.status === "completed") return { label: "Completed", tone: "done" };
  if (isUnopened(order)) return { label: "New", tone: "new" };
  return null;
}

/**
 * The one line of items under the customer's name: the first three, and an
 * ellipsis if there are more. Enough to tell the fish from the chicken
 * across the pass; the ticket has the rest.
 */
export function itemsLine(items: Order["items"] | null | undefined, max = 3): string {
  const names = (items ?? []).map((i) => (i?.name ?? "").trim()).filter(Boolean);
  if (!names.length) return "";
  const shown = names.slice(0, max).join(" · ");
  return names.length > max ? `${shown} …` : shown;
}

/** The two looks a restaurant's tablet can have. */
export type DisplayMode = "kitchen" | "standard";

/**
 * Anything unrecognised becomes 'kitchen'.
 *
 * The default is the loud one on purpose: the failure that costs money is a
 * screen nobody notices, so a null, a typo or a column that has not been
 * migrated yet must not quietly produce the quiet look.
 */
export function displayMode(value: unknown): DisplayMode {
  return value === "standard" ? "standard" : "kitchen";
}
