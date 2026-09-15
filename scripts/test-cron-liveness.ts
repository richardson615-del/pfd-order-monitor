/**
 * Assertions for cron liveness. The job this checks hardest is the health
 * monitor itself: if /api/monitor/check stops, every other check stops with
 * it and the silence reads as good news. Both directions are tested - it must
 * fire when a job stops, and stay quiet when one is merely late.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CRON_JOBS,
  MONITOR_JOB,
  cronIssues,
  monitorSilence,
  staleAfterMinutes,
  staleCronJobs,
  type CronRunRow,
} from "@/lib/cron-liveness";
import { evaluateHealth, type HealthSnapshot } from "@/lib/health";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const NOW = new Date("2026-09-15T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

console.log("the registry matches vercel.json:");

test("every scheduled cron has a liveness entry, at the right cadence", () => {
  // The blind spot this guards: adding a cron without a liveness entry, or
  // changing a schedule and leaving the threshold behind. Either would widen
  // the gap silently, which is the failure this whole file exists to catch.
  const cfg = JSON.parse(readFileSync("vercel.json", "utf8"));
  const byPath = new Map<string, number>();
  for (const c of cfg.crons ?? []) {
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(c.schedule);
    assert.ok(m, `unsupported schedule "${c.schedule}" for ${c.path} - teach this test to read it`);
    byPath.set(c.path, Number(m![1]));
  }
  for (const [path, every] of byPath) {
    const spec = CRON_JOBS.find((j) => j.path === path);
    assert.ok(spec, `${path} is scheduled in vercel.json but has no CRON_JOBS entry`);
    assert.equal(spec!.everyMinutes, every, `${path} cadence drifted from vercel.json`);
  }
  for (const spec of CRON_JOBS) {
    assert.ok(byPath.has(spec.path), `${spec.path} is in CRON_JOBS but not scheduled in vercel.json`);
  }
});

console.log("stale detection:");

test("a job that has never run is not reported", () => {
  // Before first deploy, silence is the expected state, not a fault - the
  // same judgement the webhook check makes with `if (lastReceiptAt)`.
  assert.deepEqual(staleCronJobs([], NOW), []);
});

test("a job running on schedule is not reported", () => {
  const runs: CronRunRow[] = [{ job: "gmail_poll", last_run_at: minsAgo(1) }];
  assert.deepEqual(staleCronJobs(runs, NOW), []);
});

test("a merely late job is not reported", () => {
  const spec = CRON_JOBS.find((j) => j.job === "gmail_poll")!;
  const runs: CronRunRow[] = [{ job: "gmail_poll", last_run_at: minsAgo(staleAfterMinutes(spec) - 1) }];
  assert.deepEqual(staleCronJobs(runs, NOW), [], "lateness is not death; alerting on it gets the channel muted");
});

test("a stopped job is reported at the threshold", () => {
  const spec = CRON_JOBS.find((j) => j.job === "gmail_poll")!;
  const runs: CronRunRow[] = [{ job: "gmail_poll", last_run_at: minsAgo(staleAfterMinutes(spec)) }];
  const stale = staleCronJobs(runs, NOW);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].spec.job, "gmail_poll");
});

test("the grace period is at least ten minutes even for a fast cron", () => {
  // A 2-minute cron with a bare 5x grace would alert 10 minutes in; the floor
  // keeps a brief deploy pause from paging anyone.
  const fast = { job: "x", label: "x", everyMinutes: 1, path: "/x" };
  assert.ok(staleAfterMinutes(fast) >= 10);
});

console.log("the findings:");

test("a stopped cron is CRITICAL and names the path and cadence", () => {
  const spec = CRON_JOBS.find((j) => j.job === "gmail_poll")!;
  const [i] = cronIssues([{ spec, minutes: 45 }]);
  assert.equal(i.severity, "critical");
  assert.equal(i.key, "cron_silent:gmail_poll");
  assert.match(i.detail, /\/api\/gmail\/poll/);
  assert.match(i.detail, /every 2 min/);
});

test("the monitor's own death says that every other check is down with it", () => {
  // Without this sentence the reader's natural conclusion from a quiet
  // dashboard is "nothing is wrong", which is exactly backwards.
  const spec = CRON_JOBS.find((j) => j.job === MONITOR_JOB)!;
  const [i] = cronIssues([{ spec, minutes: 120 }]);
  assert.match(i.detail, /absence of alerts means nothing/);
});

test("a stopped cron reaches a phone", async () => {
  const { composeSmsAlert } = await import("@/lib/alerts");
  const spec = CRON_JOBS.find((j) => j.job === MONITOR_JOB)!;
  assert.ok(composeSmsAlert(cronIssues([{ spec, minutes: 120 }])), "a dead monitor must wake someone");
});

console.log("the watchdog's judgement:");

const monitorSpec = CRON_JOBS.find((j) => j.job === MONITOR_JOB)!;
const STALE = staleAfterMinutes(monitorSpec);

test("a running monitor raises nothing", () => {
  const r = monitorSilence({ job: MONITOR_JOB, last_run_at: minsAgo(5) }, NOW);
  assert.equal(r.silent, false);
  assert.equal(r.alert, false);
});

test("a monitor with no row at all raises nothing", () => {
  // Not yet deployed. Alerting here would fire on every fresh environment.
  assert.equal(monitorSilence(null, NOW).alert, false);
});

test("a silent monitor alerts once", () => {
  const r = monitorSilence({ job: MONITOR_JOB, last_run_at: minsAgo(STALE + 5) }, NOW);
  assert.equal(r.silent, true);
  assert.equal(r.alert, true);
});

test("an already-reported silent monitor does not alert again", () => {
  // The Gmail poll runs every 2 minutes. Without this it would send 30 texts
  // an hour, and a muted channel is the same failure in different clothing.
  const r = monitorSilence(
    { job: MONITOR_JOB, last_run_at: minsAgo(STALE + 5), silent_alerted_at: minsAgo(3) },
    NOW
  );
  assert.equal(r.silent, true);
  assert.equal(r.alert, false, "report once, not every run");
});

console.log("through the health engine:");

const bare: HealthSnapshot = {
  devices: [], inboxes: [], restaurantsWithoutDevice: [], pendingJobs: [], failedJobs: [],
  unreconciledOrders: [], unsentEmailJobs: [], undeliveredAppAlerts: [],
  restaurantsWithoutAppDevice: [], tabletsNotWatching: [], unacceptedOrders: [],
  webhook: { lastReceiptAt: null, lastAcceptedAt: null, recentTotal: 0, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] },
  cronRuns: [],
  restaurantVolumes: [],
};

test("a stopped cron surfaces through evaluateHealth", () => {
  const snap = { ...bare, cronRuns: [{ job: "gmail_poll", last_run_at: minsAgo(600) }] };
  const keys = evaluateHealth(snap, NOW).map((i) => i.key);
  assert.ok(keys.includes("cron_silent:gmail_poll"));
});

test("healthy crons add nothing", () => {
  const snap = {
    ...bare,
    cronRuns: [
      { job: "gmail_poll", last_run_at: minsAgo(1) },
      { job: MONITOR_JOB, last_run_at: minsAgo(5) },
    ],
  };
  assert.deepEqual(evaluateHealth(snap, NOW), []);
});

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
