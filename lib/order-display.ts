/**
 * What an order looks like on the tablet.
 *
 * Pure functions, separate from the card that renders them, because these are
 * the decisions worth testing: when an order starts reading as late, and what
 * a row says about itself. Both display modes call the same ones - kitchen and
 * standard differ in size and loudness, never in what they claim.
 */
import { Order } from "./types";

/**
 * When an unaccepted order starts reading as late.
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
 * True once nobody needs to act on this order.
 *
 * Acceptance, not status 'opened'. Tapping an order to read it is not the same
 * as agreeing to cook it, which is the distinction the chime is built on -
 * this keeps the colour on the card telling the same story as the noise in
 * the room.
 */
export function isSettled(order: Pick<Order, "status" | "accepted_at">): boolean {
  return Boolean(order.accepted_at) || SETTLED.has(order.status);
}

/**
 * How old the order is, in ms, or null if we cannot tell.
 *
 * received_at is Zuppler's own timestamp rather than when we ingested it, so
 * this is how long the CUSTOMER has been waiting, which is the number that
 * matters in a kitchen.
 */
export function ageMs(order: Pick<Order, "received_at">, now: number): number | null {
  if (!order.received_at) return null;
  const t = new Date(order.received_at).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now - t);
}

/**
 * The class that drives the urgency rail and the timer colour.
 *
 * A settled order is never late however old it is: an order from this morning
 * that was cooked and completed is history, not a problem, and colouring it
 * red would teach the kitchen that red means nothing.
 */
export function ageClass(
  order: Pick<Order, "status" | "accepted_at" | "received_at">,
  now: number
): "settled" | "age-calm" | "age-warn" | "age-late" {
  if (isSettled(order)) return "settled";
  const age = ageMs(order, now);
  if (age === null) return "age-calm";
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
export function elapsedLabel(order: Pick<Order, "received_at">, now: number): string {
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
  tone: "waiting" | "done" | "printed" | "cancelled";
}

/**
 * What the badge on a row says.
 *
 * Said in terms of what somebody has to do, not the database's own word for
 * the row. 'new' and 'opened' both mean nobody has agreed to cook it, so both
 * read WAITING - a kitchen acting on the difference between those two would be
 * acting on whether someone glanced at the screen.
 */
export function orderFlag(order: Pick<Order, "status" | "accepted_at">): OrderFlag {
  if (order.status === "cancelled") return { label: "Cancelled", tone: "cancelled" };
  if (order.accepted_at) return { label: "Accepted", tone: "done" };
  if (order.status === "completed") return { label: "Completed", tone: "done" };
  if (order.status === "printed") return { label: "Waiting", tone: "waiting" };
  return { label: "Waiting", tone: "waiting" };
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
