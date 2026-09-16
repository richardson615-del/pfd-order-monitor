/**
 * When a queued ticket should NOT come out of the printer.
 *
 * Seen on 2026-09-15: an order eleven days old printed at a restaurant,
 * because nothing between the queue and the paper ever asked how old the
 * order was. The claim query took the oldest queued job; a reprint reset
 * the retry budget; three rapid retries ~5 s apart fought an empty paper
 * roll before anyone could reach it; and the failure the office saw was
 * `ePOS code="EPTR_REC_EMPTY"`. Four rules, all pure so they are tested
 * without a printer:
 *
 *   1. An order older than PRINT_MAX_AGE_HOURS is EXPIRED at claim time,
 *      never printed and never ticketed - unless somebody asked for it in
 *      the last ten minutes (manual_reprint_at), which is the one case an
 *      old ticket is wanted.
 *   2. A reprint of an old order does not get its attempts back: one shot,
 *      no retry loop for a ticket nobody is waiting on.
 *   3. The printer's codes are said in plain English, in the job's error
 *      and therefore in the CRM's ticket title.
 *   4. Out of paper / cover open HOLDS the job instead of burning three
 *      attempts in fifteen seconds; the device's later polls release it
 *      and it prints once the roll is back, up to an hour, then it fails
 *      with the reason.
 */

export const DEFAULT_PRINT_MAX_AGE_HOURS = 4;

/** How old an order may be and still print, from PRINT_MAX_AGE_HOURS (hours, default 4). */
export function printMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PRINT_MAX_AGE_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRINT_MAX_AGE_HOURS;
  return hours * 60 * 60_000;
}

/** A manual reprint asked for this recently prints regardless of the order's age. */
export const MANUAL_REPRINT_GRACE_MS = 10 * 60_000;

/** A held job is offered to the printer again this long after its last hold. */
export const HOLD_RETRY_MS = 2 * 60_000;

/** A job held this long since its FIRST hold gives up - with the reason, not a code. */
export const HOLD_MAX_MS = 60 * 60_000;

export type ClaimDecision = "print" | "expire";

/**
 * Whether a queued job may go to paper now. Documents (no order) always
 * may: a login ticket has no age. An order without a received_at is
 * printed rather than guessed about.
 */
export function claimDecision(args: {
  /** orders.received_at, or null for a document job. */
  receivedAt: string | null | undefined;
  manualReprintAt: string | null | undefined;
  now: number;
  maxAgeMs: number;
}): ClaimDecision {
  if (!args.receivedAt) return "print";
  const received = Date.parse(args.receivedAt);
  if (Number.isNaN(received)) return "print";
  if (args.now - received <= args.maxAgeMs) return "print";
  const asked = args.manualReprintAt ? Date.parse(args.manualReprintAt) : NaN;
  if (!Number.isNaN(asked) && args.now - asked <= MANUAL_REPRINT_GRACE_MS) return "print";
  return "expire";
}

/** The sentence an expired job carries, so "why did this not print?" is answerable from the row. */
export function expiredReason(receivedAt: string, now: number): string {
  const hours = Math.floor((now - Date.parse(receivedAt)) / 3_600_000);
  const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
  return `Order was ${age} old when it reached the printer - not printed. Use Print on the order if it is still wanted.`;
}

/**
 * Whether a reprint gets a fresh retry budget. A recent order does (the
 * budget is per attempt to print, and this is a new one). An old one does
 * not: it prints once if it can, and never loops.
 */
export function reprintResetsAttempts(args: { receivedAt: string | null | undefined; now: number; maxAgeMs: number }): boolean {
  if (!args.receivedAt) return true;
  const received = Date.parse(args.receivedAt);
  if (Number.isNaN(received)) return true;
  return args.now - received <= args.maxAgeMs;
}

export interface PrinterCode {
  /** The vendor's code, kept for the log. */
  code: string;
  /** What to tell a person. */
  message: string;
  /** True when the printer will very likely clear it by itself once somebody touches it - so hold, do not retry. */
  hold: boolean;
}

/**
 * ePOS-Print / Server Direct Print result codes, in plain English. The
 * codes are quoted from the ePOS-Print XML reference; anything unknown is
 * shown as the code so nothing is hidden.
 */
export function describePrinterCode(rawCode: string | null | undefined): PrinterCode {
  const code = (rawCode ?? "").trim();
  const c = code.toUpperCase();
  if (c === "EPTR_REC_EMPTY") return { code, message: "Printer is out of paper", hold: true };
  if (c === "EPTR_COVER_OPEN") return { code, message: "Printer cover is open", hold: true };
  if (c === "EPTR_REC_NEAR_END") return { code, message: "Paper is running low", hold: false };
  if (c === "EPTR_AUTOMATICAL" || c === "EPTR_CUTTER") return { code, message: "Printer needs attention (paper jam or cutter)", hold: true };
  if (c === "EPTR_MECHANICAL" || c === "EPTR_UNRECOVERABLE") return { code, message: "Printer reports a hardware fault", hold: false };
  if (c === "EPTR_BATTERY_LOW") return { code, message: "Printer battery is low", hold: false };
  if (c === "SCHEMAERROR" || c === "DEVICENOTFOUND" || c === "PRINTSYSTEMERROR") return { code, message: "Printer offline or misconfigured", hold: false };
  if (c === "EX_TIMEOUT" || c === "ERR_TIMEOUT" || /TIMEOUT/.test(c) || c === "") return { code, message: "Printer offline", hold: false };
  if (c === "ERR_PARAM" || c === "ERR_SPOOLER" || c === "ERR_MEMORY" || c === "ERR_PROCESSING") return { code, message: "Printer could not process the ticket", hold: false };
  return { code, message: `Printer error ${code}`, hold: false };
}

/** The error text stored on the job: the sentence, then the code for whoever reads the log. */
export function printErrorText(pc: PrinterCode): string {
  return pc.code ? `${pc.message} (${pc.code})` : pc.message;
}

export interface FailureTransition {
  status: "held" | "queued" | "failed";
  attempts: number;
  error: string;
}

/** What a failed print result does to the job. */
export function failureTransition(args: {
  code: string | null | undefined;
  attempts: number;
  /** print_jobs.held_since - when this job was first held, if ever. */
  heldSince: string | null | undefined;
  now: number;
  maxAttempts?: number;
}): FailureTransition {
  const pc = describePrinterCode(args.code);
  const error = printErrorText(pc);
  if (pc.hold) {
    // Out of paper is not a failed attempt; it is a printer waiting for a
    // person. Held, and the device's polls bring it back. Past the cap it
    // fails, and the sentence says how long the roll has been empty.
    const since = args.heldSince ? Date.parse(args.heldSince) : NaN;
    if (!Number.isNaN(since) && args.now - since >= HOLD_MAX_MS) {
      return { status: "failed", attempts: args.attempts, error: `${pc.message} for over an hour (${pc.code})` };
    }
    return { status: "held", attempts: args.attempts, error };
  }
  const attempts = args.attempts + 1;
  const max = args.maxAttempts ?? 3;
  return { status: attempts < max ? "queued" : "failed", attempts, error };
}

/** Whether a held job should be offered again on this poll. */
export function holdReleased(heldAt: string | null | undefined, now: number): boolean {
  if (!heldAt) return true;
  const t = Date.parse(heldAt);
  return Number.isNaN(t) || now - t >= HOLD_RETRY_MS;
}

/** Who put a job in the queue - the vocabulary of print_jobs.queued_by. */
export type QueuedBy = "ingest" | "test" | "login_print" | `reprint:${string}`;
export const reprintBy = (actor: string): QueuedBy => `reprint:${actor.trim() || "unknown"}`;
