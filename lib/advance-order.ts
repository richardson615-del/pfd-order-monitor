/**
 * Advance orders go to the kitchen printer near their due time (CRM Ticket
 * #1429, Forrest; window set by Nick, 2026-11-10: 45 minutes).
 *
 * Before this, every order printed the moment it arrived, whatever its due
 * time: an order placed at 2:30 PM for 4:30 PM came out of the printer at
 * 2:30 and was cooked early or lost. Now, at a restaurant that has the tablet
 * app, an order due more than the window away is NOT queued to the printer at
 * ingest. The tablet lists it at once (as scheduled, lib/order-display.ts), so
 * the kitchen can always see it; the minute monitor cron queues the paper at
 * `due - window` (`releaseAdvanceOrders`).
 *
 * Built so an order can not be held and then never printed:
 *   - No schema change. A held order is simply an order with no printer job
 *     yet; nothing else marks it, so there is no flag to get stuck.
 *   - EVERY restaurant is held (Matt, 2026-11-11: "they all need to be the
 *     same but lets switch it to one hour ... we auto send larger orders
 *     earlier $150+ 1.5 hours early $250+ 2 hours early"): tablet, Eatabit,
 *     Epson and the PC email we send. The window is 60 minutes, 90 for an
 *     order of $150 or more, 120 for $250 or more (`advanceWindowMinutes`,
 *     on the customer total). Zuppler's own emails to a PC are Zuppler's and
 *     can not be held. Dispatch can send any held order at once
 *     (`send_to_kitchen`, app/api/crm/orders/[id]/actions).
 *   - Any doubt prints now: no due time, an unreadable one, an error while
 *     deciding, the window switched off (ADVANCE_HOLD_MINUTES=0).
 *   - The release sweep looks at every order whose release time has passed
 *     and that still has no printer job, so a missed minute is caught by the
 *     next one. It also catches an order whose ingest queueing failed.
 *   - A reprint by hand (tablet or CRM) queues a job like always; the sweep
 *     then sees the job and leaves the order alone.
 *   - A released job is stamped `manual_reprint_at`, and re-stamped each
 *     minute while it waits, because the printer queue expires jobs for orders
 *     older than PRINT_MAX_AGE_HOURS (lib/print-policy.ts) and an advance
 *     order is old by design.
 *
 * This file is the pure half (no database): safe to import from the ticket
 * renderer. The sweep that touches the database is lib/advance-hold.ts.
 */

export const DEFAULT_ADVANCE_HOLD_MINUTES = 60;
/** Larger orders go to the kitchen earlier (Matt 2026-11-11). Dollars of the customer total -> minutes before due. */
export const ADVANCE_LARGE_ORDER_TIERS: readonly { minTotal: number; minutes: number }[] = [
  { minTotal: 250, minutes: 120 },
  { minTotal: 150, minutes: 90 },
];
/** The longest any order is held ahead of its due time: the sweep reads this far ahead. */
export function maxAdvanceWindowMinutes(baseMinutes: number): number {
  if (baseMinutes <= 0) return 0;
  return Math.max(baseMinutes, ...ADVANCE_LARGE_ORDER_TIERS.map((t) => t.minutes));
}

/** This order's window: the base, or more for a large order. 0 (hold off) stays 0. A missing or unreadable total is the base. */
export function advanceWindowMinutes(customerTotal: number | string | null | undefined, baseMinutes: number): number {
  if (baseMinutes <= 0) return 0;
  const total = customerTotal == null || customerTotal === "" ? NaN : Number(customerTotal);
  if (Number.isFinite(total)) {
    for (const t of ADVANCE_LARGE_ORDER_TIERS) if (total >= t.minTotal) return Math.max(baseMinutes, t.minutes);
  }
  return baseMinutes;
}
/** A release this long after the due time is not printed: nobody is waiting on that ticket. */
export const ADVANCE_RELEASE_STALE_MS = 2 * 60 * 60_000;
export const ADVANCE_RELEASE_QUEUED_BY = "advance_release";

/** Minutes before the due time that the paper is queued. 0 = the hold is off and everything prints at ingest. */
export function advanceHoldMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.ADVANCE_HOLD_MINUTES ?? "").trim();
  if (raw === "") return DEFAULT_ADVANCE_HOLD_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ADVANCE_HOLD_MINUTES;
  return Math.floor(n);
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** An order placed for later: due more than the window after it was received. Used for the ticket's ADVANCE ORDER line. */
export function isAdvanceOrder(o: { due_time?: string | null; received_at?: string | null }, windowMinutes = DEFAULT_ADVANCE_HOLD_MINUTES): boolean {
  const due = ms(o.due_time);
  const recv = ms(o.received_at);
  if (!Number.isFinite(due) || !Number.isFinite(recv) || windowMinutes <= 0) return false;
  return due - recv > windowMinutes * 60_000;
}

export type AdvanceHoldDecision = { hold: false; reason: string } | { hold: true; releaseAt: string };

/** Pure: at ingest, is this order's paper held for later? Every "no" names why, for the log. */
export function advanceHoldDecision(args: {
  now: number;
  dueTime: string | null | undefined;
  source: string | null | undefined;
  printMethod?: string | null | undefined;
  /** Dollars. Sets the window for a large order. */
  customerTotal?: number | string | null;
  /** The base window (advanceHoldMinutes()). */
  windowMinutes: number;
}): AdvanceHoldDecision {
  if (args.windowMinutes <= 0) return { hold: false, reason: "hold switched off" };
  if (args.source === "test") return { hold: false, reason: "test order" };
  // ezCater has its own lead-time rule (lib/ezcater-promote.ts): it reaches ingest only when it is time.
  if (args.source === "ezcater") return { hold: false, reason: "ezCater has its own kitchen lead time" };
  const due = ms(args.dueTime);
  if (!Number.isFinite(due)) return { hold: false, reason: "no due time (ASAP)" };
  const window = advanceWindowMinutes(args.customerTotal, args.windowMinutes);
  const releaseAt = due - window * 60_000;
  if (releaseAt <= args.now) return { hold: false, reason: "due within the window" };
  return { hold: true, releaseAt: new Date(releaseAt).toISOString() };
}

/** Pure: should the sweep queue this order's paper now? The order's own window (larger orders earlier). */
export function advanceReleaseDue(o: { due_time?: string | null; received_at?: string | null; customer_total?: number | string | null }, now: number, baseMinutes: number): boolean {
  const due = ms(o.due_time);
  const window = advanceWindowMinutes(o.customer_total, baseMinutes);
  if (!Number.isFinite(due) || window <= 0) return false;
  if (!isAdvanceOrder(o, window)) return false;
  if (now < due - window * 60_000) return false;
  return now - due <= ADVANCE_RELEASE_STALE_MS;
}

/** Pure: when a held order goes to the kitchen, or null when it is not held. For the CRM's "Goes to the kitchen at". */
export function advanceReleaseAt(o: { due_time?: string | null; received_at?: string | null; customer_total?: number | string | null }, baseMinutes: number): string | null {
  const due = ms(o.due_time);
  const window = advanceWindowMinutes(o.customer_total, baseMinutes);
  if (!Number.isFinite(due) || window <= 0 || !isAdvanceOrder(o, window)) return null;
  return new Date(due - window * 60_000).toISOString();
}
