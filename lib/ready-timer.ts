import { MAX_PREP_MINUTES, MIN_PREP_MINUTES, isValidPrepMinutes } from "./countdown";

/**
 * The order ready timer (PA5, Matt 2026-10-26): "The restaurant app also
 * need to be able to set timer for when order will be ready and a ready
 * button for when it ready. The driver needs to be able to see this timer
 * as well."
 *
 * Accept now says HOW LONG: the kitchen picks the minutes (10 / 15 / 20 /
 * 25 / 30 / 45, the restaurant's prep target highlighted) and the order
 * gets ready_minutes and ready_by = accepted_at + minutes (migration 055).
 * READY is its own tap - the food is on the pass - and stamps ready_at once.
 * COMPLETE stays what it was: the order is gone. "Running late" moves
 * ready_by on by five or ten minutes. The CRM reads all three from the
 * order feed and shows the driver the same clock.
 *
 * Pure: the PATCH route, the tablet and the tests share these rules.
 */

/** The quick picks on Accept. The restaurant's own target is added when it is not one of them. */
export const READY_MINUTE_CHOICES: readonly number[] = [10, 15, 20, 25, 30, 45];

/** "Running late" adds one of these. */
export const RUNNING_LATE_STEPS: readonly number[] = [5, 10];

/** The quick picks with the restaurant's target among them, ascending. */
export function readyChoices(defaultMinutes: number): number[] {
  const set = new Set(READY_MINUTE_CHOICES);
  if (isValidPrepMinutes(defaultMinutes)) set.add(defaultMinutes);
  return [...set].sort((a, b) => a - b);
}

export type OrderPatch =
  | { kind: "accept"; minutes: number | null }
  | { kind: "ready" }
  | { kind: "retime"; minutes: number }
  | { kind: "status"; status: "new" | "opened" | "completed" | "printed" };

export type OrderPatchResult = { ok: true; patch: OrderPatch } | { ok: false; error: string; code: string };

const minutesError = `minutes must be a whole number from ${MIN_PREP_MINUTES} to ${MAX_PREP_MINUTES}`;

/**
 * What a PATCH /api/orders/:id body asks for. One action per call:
 *   { accepted: true, minutes? }  accept (minutes default to the prep target)
 *   { ready: true }               the food is ready
 *   { minutes }                   re-time an accepted order (minutes from Accept)
 *   { status }                    the old status writes, unchanged
 */
export function parseOrderPatch(body: unknown): OrderPatchResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const hasMinutes = "minutes" in b && b.minutes !== undefined && b.minutes !== null;
  if (hasMinutes && !isValidPrepMinutes(b.minutes)) return { ok: false, error: minutesError, code: "invalid_minutes" };
  const minutes = hasMinutes ? (b.minutes as number) : null;

  if (b.accepted === true) return { ok: true, patch: { kind: "accept", minutes } };
  if (b.ready === true) {
    if (hasMinutes) return { ok: false, error: "send ready or minutes, not both", code: "invalid_body" };
    return { ok: true, patch: { kind: "ready" } };
  }
  if ("status" in b) {
    const s = b.status;
    if (s === "new" || s === "opened" || s === "completed" || s === "printed") return { ok: true, patch: { kind: "status", status: s } };
    return { ok: false, error: "invalid status", code: "invalid_status" };
  }
  if (minutes !== null) return { ok: true, patch: { kind: "retime", minutes } };
  return { ok: false, error: "invalid status", code: "invalid_status" };
}

/** accepted_at + minutes, as an ISO timestamp, or null when accepted_at cannot be read. */
export function readyByFor(acceptedAt: string | null | undefined, minutes: number): string | null {
  const t = Date.parse(acceptedAt ?? "");
  if (Number.isNaN(t)) return null;
  return new Date(t + minutes * 60_000).toISOString();
}

export interface ReadyFields {
  accepted_at: string | null;
  ready_by?: string | null;
  ready_minutes?: number | null;
  ready_at?: string | null;
  status: string;
}

/** Whether the kitchen has tapped READY. */
export const isReady = (o: Pick<ReadyFields, "ready_at">): boolean => Boolean(o.ready_at);

/**
 * Why an order cannot be re-timed or marked ready, or null when it can.
 * Re-timing needs an accepted order that is not ready, completed or
 * cancelled; Ready needs one that is not completed or cancelled.
 */
export function refuseReadyChange(o: ReadyFields, kind: "ready" | "retime"): { error: string; code: string } | null {
  if (o.status === "cancelled") return { error: "this order was cancelled", code: "order_cancelled" };
  if (o.status === "completed") return { error: "this order is already complete", code: "order_completed" };
  if (kind === "retime") {
    if (!o.accepted_at) return { error: "accept the order first", code: "not_accepted" };
    if (o.ready_at) return { error: "this order is already ready", code: "already_ready" };
  }
  return null;
}

/**
 * The minutes to send for "Running late +N": N more minutes from the later
 * of the current ready time and now (an order already over gets N minutes
 * from now, not N minutes that are already gone). Counted from accepted_at,
 * rounded up. Null when the order is not accepted or it would pass the
 * 180-minute ceiling.
 */
export function runningLateMinutes(
  o: Pick<ReadyFields, "accepted_at" | "ready_by">,
  add: number,
  prepMinutes: number,
  now: number
): number | null {
  const accepted = Date.parse(o.accepted_at ?? "");
  if (Number.isNaN(accepted)) return null;
  const by = Date.parse(o.ready_by ?? "");
  const due = Number.isNaN(by) ? accepted + prepMinutes * 60_000 : by;
  const target = Math.max(due, now) + add * 60_000;
  const minutes = Math.ceil((target - accepted) / 60_000);
  return isValidPrepMinutes(minutes) ? minutes : null;
}
