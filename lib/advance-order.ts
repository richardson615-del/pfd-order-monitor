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
 *   - Only a restaurant with the tablet app is held. A printer-only or
 *     email-only restaurant keeps getting its paper at once (paper is its only
 *     notice) - with the ADVANCE ORDER line on the ticket (lib/ticket.ts).
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

export const DEFAULT_ADVANCE_HOLD_MINUTES = 45;
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
  printMethod: string | null | undefined;
  appExpected: boolean | null | undefined;
  windowMinutes: number;
}): AdvanceHoldDecision {
  if (args.windowMinutes <= 0) return { hold: false, reason: "hold switched off" };
  if (args.source === "test") return { hold: false, reason: "test order" };
  // ezCater has its own lead-time rule (lib/ezcater-promote.ts): it reaches ingest only when it is time.
  if (args.source === "ezcater") return { hold: false, reason: "ezCater has its own kitchen lead time" };
  if (args.printMethod === "email") return { hold: false, reason: "email restaurant" };
  if (!args.appExpected) return { hold: false, reason: "no tablet app: paper is this restaurant's only notice" };
  const due = ms(args.dueTime);
  if (!Number.isFinite(due)) return { hold: false, reason: "no due time (ASAP)" };
  const releaseAt = due - args.windowMinutes * 60_000;
  if (releaseAt <= args.now) return { hold: false, reason: "due within the window" };
  return { hold: true, releaseAt: new Date(releaseAt).toISOString() };
}

/** Pure: should the sweep queue this order's paper now? */
export function advanceReleaseDue(o: { due_time?: string | null; received_at?: string | null }, now: number, windowMinutes: number): boolean {
  const due = ms(o.due_time);
  if (!Number.isFinite(due) || windowMinutes <= 0) return false;
  if (!isAdvanceOrder(o, windowMinutes)) return false;
  if (now < due - windowMinutes * 60_000) return false;
  return now - due <= ADVANCE_RELEASE_STALE_MS;
}

