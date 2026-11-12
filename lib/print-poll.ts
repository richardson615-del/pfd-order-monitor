/**
 * What one printer poll needs to touch (app/api/print/epson). Pure, so the
 * decisions are tested without a database (scripts/test-print-poll.ts).
 *
 * Bridge outage 2026-11-11: printers polling every few seconds were the
 * largest steady source of database statements - a device lookup, a
 * last_seen write, two releasing UPDATEs and the queued read on every poll,
 * even with nothing to print. These two functions let an idle poll be one
 * device read and one small job read.
 */

export type OpenJob = { id: string; status: string; claimed_at: string | null; held_at: string | null };

export type PollPlan = {
  /** Nothing queued, nothing to release: answer "no job" right away. */
  idle: boolean;
  /** Claimed longer ago than the stale window: put back in the queue. */
  staleClaimed: string[];
  /** Held long enough to try again: put back in the queue. */
  heldDue: string[];
  /** Whether the full queued read (with the order) is worth running. */
  readQueued: boolean;
};

const olderThan = (at: string | null, cutoffMs: number) => {
  if (!at) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && t < cutoffMs;
};

export function pollPlan(
  open: OpenJob[],
  o: { now: number; staleClaimMs: number; holdRetryMs: number }
): PollPlan {
  const staleClaimed = open
    .filter((j) => j.status === "claimed" && olderThan(j.claimed_at, o.now - o.staleClaimMs))
    .map((j) => j.id);
  const heldDue = open
    .filter((j) => j.status === "held" && olderThan(j.held_at, o.now - o.holdRetryMs))
    .map((j) => j.id);
  const queued = open.some((j) => j.status === "queued");
  const readQueued = queued || staleClaimed.length > 0 || heldDue.length > 0;
  return { idle: !readQueued, staleClaimed, heldDue, readQueued };
}

/**
 * Whether this poll should write the device's last_seen_at. Writing on every
 * poll was about 5 million updates in the 2026-11-11 report, for a column read
 * in minutes (health's deviceSilentMinutes is 15). Thirty seconds is invisible
 * to every reader. Always when the
 * stored values are wrong (first poll, a different app_version, an Eatabit
 * name not yet recorded); otherwise at most once per `everyMs`.
 */
export function shouldStampDevice(d: {
  lastSeenAt: string | null;
  appVersion: string | null;
  printerName: string | null;
  wantPrinterName: string | null;
  now: number;
  everyMs?: number;
}): boolean {
  const every = d.everyMs ?? 30_000;
  if (d.appVersion !== "server-direct-print") return true;
  if (d.wantPrinterName && d.printerName !== d.wantPrinterName) return true;
  if (!d.lastSeenAt) return true;
  const t = Date.parse(d.lastSeenAt);
  if (!Number.isFinite(t)) return true;
  return d.now - t >= every;
}
