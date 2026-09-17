import type { Order } from "./types";
import { STILL_ACTIONABLE_MS } from "./kiosk";
import { isSettled } from "./order-display";

/**
 * Accept, then a countdown (Workstream I3, Nick 2026-09-17).
 *
 * Watched on a live tablet: an order that only offers Done gives the
 * kitchen no way to say "we've got it" and no sense of time. So: the
 * order chimes until somebody taps ACCEPT; Accept starts a countdown from
 * the restaurant's prep target (25 minutes unless the CRM set otherwise);
 * it goes amber under five minutes, red at zero and then counts UP, and
 * never auto-completes - an order left on the board is a problem to see,
 * not to hide. COMPLETE (was Done) ends it and records the real minutes.
 *
 * Computed from accepted_at + prep_minutes and the clock, never from timer
 * state, so it survives reloads and idle-time refreshes and two screens at
 * one restaurant agree to the second. Pure, like lib/kiosk.ts, for the
 * same reason: these rules decide what a kitchen hears and sees.
 */

export const DEFAULT_PREP_MINUTES = 25;
export const MIN_PREP_MINUTES = 1;
export const MAX_PREP_MINUTES = 180;

/** Under this much left the countdown is amber. */
export const COUNTDOWN_AMBER_MS = 5 * 60_000;

/** The restaurant's prep target, or the default when the column is unset or nonsense. */
export function prepMinutesOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= MIN_PREP_MINUTES && n <= MAX_PREP_MINUTES ? n : DEFAULT_PREP_MINUTES;
}

/** Whether a value the CRM sends may be stored as prep_minutes. */
export const isValidPrepMinutes = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_PREP_MINUTES && value <= MAX_PREP_MINUTES;

export type CountdownPhase = "calm" | "amber" | "over";

export interface Countdown {
  /** Positive while time is left, negative once over. */
  remainingMs: number;
  phase: CountdownPhase;
  /** "24:59", "04:59", or "+3:12 over". */
  label: string;
  /** accepted_at + prep, as a timestamp. */
  dueAt: number;
}

const mmss = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/**
 * The countdown for an accepted, unsettled order, or null when there is
 * none to show (not accepted yet, completed, cancelled, or an accepted_at
 * that cannot be read).
 */
export function countdown(
  order: Pick<Order, "status" | "accepted_at">,
  prepMinutes: number,
  now: number
): Countdown | null {
  if (isSettled(order) || !order.accepted_at) return null;
  const accepted = Date.parse(order.accepted_at);
  if (Number.isNaN(accepted)) return null;
  const dueAt = accepted + prepMinutesOf(prepMinutes) * 60_000;
  const remainingMs = dueAt - now;
  // Zero itself is over: "red at 0:00" (Nick), and the single chime fires then.
  if (remainingMs <= 0) {
    const over = -remainingMs;
    const total = Math.floor(over / 1000);
    return { remainingMs, phase: "over", label: `+${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} over`, dueAt };
  }
  return { remainingMs, phase: remainingMs < COUNTDOWN_AMBER_MS ? "amber" : "calm", label: mmss(remainingMs), dueAt };
}

/** Whether an order in the kitchen is waiting for Accept. */
export const isUnaccepted = (order: Pick<Order, "status" | "accepted_at">): boolean =>
  !isSettled(order) && !order.accepted_at;

/**
 * The kitchen list's order: unaccepted first, oldest first (the one that
 * has waited longest is the one to take next); then accepted, least time
 * remaining first (the one due soonest - or most over - is on top).
 */
export function kitchenSort<T extends Pick<Order, "status" | "accepted_at" | "received_at">>(
  orders: T[],
  prepMinutes: number,
  now: number
): T[] {
  return [...orders].sort((a, b) => {
    const ua = isUnaccepted(a);
    const ub = isUnaccepted(b);
    if (ua !== ub) return ua ? -1 : 1;
    if (ua) return a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0;
    const ra = countdown(a, prepMinutes, now)?.remainingMs ?? Infinity;
    const rb = countdown(b, prepMinutes, now)?.remainingMs ?? Infinity;
    return ra - rb;
  });
}

export interface HeroSummary {
  count: number;
  unaccepted: number;
  /** The soonest countdown among accepted orders, or null when none is accepted. */
  next: Countdown | null;
  /** Red when an unaccepted order is late or any countdown is over; busy otherwise; idle when empty. */
  tone: "late" | "busy" | "idle";
  /** "3 orders · 1 not accepted · next up in 04:10" */
  text: string;
}

/** What the hero line says. Counts unaccepted first, then the soonest countdown. */
export function heroSummary<T extends Pick<Order, "status" | "accepted_at" | "received_at">>(
  kitchen: T[],
  prepMinutes: number,
  now: number,
  lateMs: number
): HeroSummary {
  const count = kitchen.length;
  const unacceptedOrders = kitchen.filter(isUnaccepted);
  const countdowns = kitchen
    .map((o) => countdown(o, prepMinutes, now))
    .filter((c): c is Countdown => c !== null)
    .sort((a, b) => a.remainingMs - b.remainingMs);
  const next = countdowns[0] ?? null;
  const unacceptedLate = unacceptedOrders.some((o) => {
    const t = Date.parse(o.received_at ?? "");
    return !Number.isNaN(t) && now - t >= lateMs && now - t < STILL_ACTIONABLE_MS;
  });
  const anyOver = countdowns.some((c) => c.phase === "over");
  const tone: HeroSummary["tone"] = count === 0 ? "idle" : unacceptedLate || anyOver ? "late" : "busy";

  const parts: string[] = [`${count} ${count === 1 ? "order" : "orders"}`];
  if (unacceptedOrders.length) parts.push(`${unacceptedOrders.length} not accepted`);
  if (next) parts.push(next.phase === "over" ? `${next.label.replace(/ over$/, "")} over` : `next up in ${next.label}`);
  return { count, unaccepted: unacceptedOrders.length, next, tone, text: count ? parts.join(" · ") : "All clear" };
}

/** "17 min" between Accept and Complete, or null when either is missing. Never negative. */
export function prepTimeLabel(acceptedAt: string | null | undefined, completedAt: string | null | undefined): string | null {
  if (!acceptedAt || !completedAt) return null;
  const a = Date.parse(acceptedAt);
  const c = Date.parse(completedAt);
  if (Number.isNaN(a) || Number.isNaN(c) || c < a) return null;
  return `${Math.round((c - a) / 60_000)} min`;
}

/**
 * Which orders just crossed zero since the last tick - the ones that get
 * the single short chime. `alreadyOver` is the set of ids the screen has
 * chimed for (or saw already over when it loaded, so a reload does not
 * re-announce an order that went over an hour ago); it is updated here.
 */
export function newlyOver<T extends Pick<Order, "id" | "status" | "accepted_at">>(
  orders: T[],
  prepMinutes: number,
  now: number,
  alreadyOver: Set<string>
): T[] {
  const out: T[] = [];
  for (const o of orders) {
    const c = countdown(o, prepMinutes, now);
    if (c?.phase === "over") {
      if (!alreadyOver.has(o.id)) {
        alreadyOver.add(o.id);
        out.push(o);
      }
    } else if (alreadyOver.has(o.id)) {
      alreadyOver.delete(o.id);
    }
  }
  return out;
}
