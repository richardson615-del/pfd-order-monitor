import type { HealthIssue } from "@/lib/health";

/**
 * Liveness for the scheduled jobs (migration 029).
 *
 * Every other check in this codebase asks whether the work arrived. This one
 * asks whether the worker ran at all, which is the failure the others cannot
 * see: a cron that stops firing produces no orders, no receipts and no
 * errors, and from the outside that is identical to a quiet night.
 *
 * The decision functions here are pure so they can be tested without a
 * scheduler; the two that touch the database never throw, because recording
 * liveness must not be able to break the job whose liveness it records.
 */

export interface CronJobSpec {
  /** Primary key in cron_runs. */
  job: string;
  label: string;
  /** Cadence from vercel.json. */
  everyMinutes: number;
  path: string;
}

/**
 * The scheduled jobs and how often vercel.json says they run.
 *
 * scripts/test-cron-liveness.ts parses vercel.json and asserts this list
 * matches it, so adding a cron without a liveness entry - or changing a
 * schedule and leaving the threshold behind - fails the suite rather than
 * silently widening the blind spot.
 */
export const CRON_JOBS: CronJobSpec[] = [
  { job: "gmail_poll", label: "Gmail poll", everyMinutes: 2, path: "/api/gmail/poll" },
  { job: "monitor_check", label: "Health monitor", everyMinutes: 15, path: "/api/monitor/check" },
];

export const MONITOR_JOB = "monitor_check";

export interface CronRunRow {
  job: string;
  last_run_at: string | null;
  silent_alerted_at?: string | null;
}

/**
 * How late a job may be before it counts as stopped.
 *
 * Five missed runs, floored at 10 minutes. Generous on purpose and for the
 * same reason deviceSilentMinutes is: a scheduler is allowed to be late, a
 * deploy briefly pauses crons, and an alert that fires on ordinary lateness
 * is one people stop reading.
 */
export function staleAfterMinutes(spec: CronJobSpec): number {
  return Math.max(10, spec.everyMinutes * 5);
}

const minutesSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 60000);
};

export interface StaleCron {
  spec: CronJobSpec;
  minutes: number;
}

/**
 * Which jobs have stopped.
 *
 * A job with NO row has never run, and is deliberately not reported: before a
 * job is deployed for the first time its silence is the expected state, not a
 * fault - the same judgement the webhook check makes with `if (lastReceiptAt)`.
 * Once a job has run even once, its silence is real.
 */
export function staleCronJobs(runs: CronRunRow[], now: Date): StaleCron[] {
  const byJob = new Map(runs.map((r) => [r.job, r]));
  const out: StaleCron[] = [];
  for (const spec of CRON_JOBS) {
    const row = byJob.get(spec.job);
    if (!row) continue; // never run - not yet deployed
    const mins = minutesSince(row.last_run_at, now);
    if (mins === null) continue;
    if (mins >= staleAfterMinutes(spec)) out.push({ spec, minutes: mins });
  }
  return out;
}

const ago = (mins: number): string =>
  mins < 60 ? `${mins} min ago`
  : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
  : `${Math.floor(mins / 1440)}d ago`;

/** Stale jobs -> findings, in the same shape every other check produces. */
export function cronIssues(stale: StaleCron[]): HealthIssue[] {
  return stale.map(({ spec, minutes }) => ({
    key: `cron_silent:${spec.job}`,
    severity: "critical" as const,
    title: `Scheduled job stopped: ${spec.label}`,
    detail:
      `${spec.path} last ran ${ago(minutes)}, and vercel.json schedules it every ${spec.everyMinutes} min. ` +
      (spec.job === MONITOR_JOB
        ? "While it is down every other health check is down with it, so the absence of alerts means nothing. "
        : "Orders are not being collected while it is down. ") +
      "Check the Vercel cron log and the job's CRON_SECRET.",
  }));
}

/**
 * Whether the health monitor has gone quiet, and whether that has already
 * been reported.
 *
 * Pure so the watchdog's judgement is testable without a scheduler or a
 * clock. `alert` is false once silent_alerted_at is set, so the job that
 * notices reports once rather than every two minutes - the same
 * report-once-then-resolve contract monitor_alerts gives every other finding.
 */
export function monitorSilence(
  row: CronRunRow | null | undefined,
  now: Date
): { silent: boolean; minutes: number | null; alert: boolean } {
  const spec = CRON_JOBS.find((j) => j.job === MONITOR_JOB)!;
  if (!row) return { silent: false, minutes: null, alert: false };
  const minutes = minutesSince(row.last_run_at, now);
  const silent = minutes !== null && minutes >= staleAfterMinutes(spec);
  return { silent, minutes, alert: silent && !row.silent_alerted_at };
}

/* ------------------------------------------------------------------ */
/* database side - neither of these may throw                          */
/* ------------------------------------------------------------------ */

/**
 * Stamp a job as having run. Failures are logged, never raised: a job must
 * not fail because the table recording that it ran is unavailable.
 *
 * Clearing silent_alerted_at here is what re-arms the watchdog, so a monitor
 * that dies, is reported, recovers and dies again is reported both times.
 */
export async function recordCronRun(
  admin: { from: (t: string) => any },
  job: string,
  opts: { ok?: boolean; detail?: string } = {}
): Promise<void> {
  const now = new Date().toISOString();
  try {
    const { error } = await admin.from("cron_runs").upsert(
      {
        job,
        last_run_at: now,
        ...(opts.ok === false ? {} : { last_ok_at: now }),
        last_detail: opts.detail ?? null,
        silent_alerted_at: null,
      },
      { onConflict: "job" }
    );
    if (error) console.error(`cron_runs: could not record ${job}:`, error.message);
  } catch (err) {
    console.error(`cron_runs: could not record ${job}:`, err);
  }
}

/**
 * The cross-check: has the health monitor stopped?
 *
 * Called from the Gmail poll, which runs every 2 minutes on an independent
 * Vercel schedule. This is the only place the monitor's own death can be
 * noticed, because every check that would notice lives inside it.
 *
 * KNOWN LIMIT: this catches the route throwing, its secret rotating, or its
 * entry being dropped from vercel.json. It does NOT catch Vercel's scheduler
 * stopping altogether, which kills both jobs at once and leaves nobody to
 * report it. Only an off-platform ping can close that gap.
 *
 * Returns the issue to announce, or null. Sending is the caller's job so
 * this stays independent of any particular alert channel.
 */
export async function checkMonitorAlive(
  admin: { from: (t: string) => any },
  now: Date = new Date()
): Promise<HealthIssue | null> {
  try {
    const { data, error } = await admin
      .from("cron_runs")
      .select("job, last_run_at, silent_alerted_at")
      .eq("job", MONITOR_JOB)
      .maybeSingle();
    if (error || !data) return null;

    const { silent, minutes, alert } = monitorSilence(data, now);
    if (!silent || !alert || minutes === null) return null;

    await admin
      .from("cron_runs")
      .update({ silent_alerted_at: now.toISOString() })
      .eq("job", MONITOR_JOB);

    const spec = CRON_JOBS.find((j) => j.job === MONITOR_JOB)!;
    return cronIssues([{ spec, minutes }])[0];
  } catch (err) {
    console.error("cron watchdog: could not check the monitor:", err);
    return null;
  }
}
