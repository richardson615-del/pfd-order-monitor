/**
 * Assertions for the volume baseline - revenue that should exist and does
 * not. This check runs across every restaurant at once, so its failure mode
 * is a weekly wall of noise that gets the channel muted. The quiet cases are
 * tested at least as hard as the loud one.
 */
import assert from "node:assert/strict";
import {
  DEFAULT_VOLUME_THRESHOLDS as T,
  poissonAtMost,
  volumeIssues,
  type RestaurantVolume,
} from "@/lib/volume-baseline";
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

/** baseline orders over 28 days -> what the recent 7 should hold. */
const expectedFor = (baseline: number) => (baseline / T.baselineDays) * T.recentDays;

const r = (over: Partial<RestaurantVolume> = {}): RestaurantVolume => ({
  restaurant_id: "r1",
  name: "Torino's",
  recent: 5,
  baseline: 120, // ~30 expected in the recent week
  established: true,
  ...over,
});

console.log("the arithmetic:");

test("a zero count against a strong rate is vanishingly unlikely", () => {
  assert.ok(poissonAtMost(0, 30) < 1e-10);
});

test("an ordinary count under its own mean is unremarkable", () => {
  const p = poissonAtMost(24, 30);
  assert.ok(p > 0.05 && p < 0.5, `expected an ordinary week, got p=${p}`);
});

test("the distribution is monotonic in the count", () => {
  let prev = -1;
  for (let k = 0; k <= 80; k++) {
    const p = poissonAtMost(k, 30);
    assert.ok(p >= prev, `p fell at k=${k}`);
    prev = p;
  }
  // 80 is about nine standard deviations above a mean of 30.
  assert.ok(Math.abs(prev - 1) < 1e-6, `it should approach 1, got ${prev}`);
});

test("an impossible mean fails quiet rather than crying wolf", () => {
  // exp(-lambda) underflows past ~745. Returning 1 means "not unusual".
  assert.equal(poissonAtMost(0, 100000), 1);
  assert.equal(poissonAtMost(5, 0), 1);
});

console.log("what stays quiet:");

test("a restaurant that grew is not flagged", () => {
  assert.deepEqual(volumeIssues([r({ recent: 45 })]), []);
});

test("an ordinary quiet week is not flagged", () => {
  // 24 against ~30 expected. Real restaurants do this constantly, and
  // alerting on it is how the channel gets muted.
  assert.deepEqual(volumeIssues([r({ recent: 24 })]), []);
});

test("a small restaurant is never judged at all", () => {
  // 20 orders across 28 days is 5 expected in the week - below minExpected,
  // so even dropping to zero says nothing. Better silent than wrong.
  assert.deepEqual(volumeIssues([r({ recent: 0, baseline: 20 })]), []);
  assert.ok(expectedFor(20) < T.minExpected);
});

test("a restaurant that onboarded mid-baseline is not flagged", () => {
  // Its baseline rate is understated by the weeks before it existed, which
  // would read as collapse the moment the window catches up.
  assert.deepEqual(volumeIssues([r({ recent: 0, established: false })]), []);
});

console.log("what fires:");

test("a collapse against a strong baseline is flagged", () => {
  const [i] = volumeIssues([r({ recent: 5 })]);
  assert.ok(i, "a 5-against-30 week must be reported");
  assert.equal(i.key, "volume_collapse:r1");
  assert.match(i.title, /down 83%/);
});

test("going to zero says so plainly", () => {
  const [i] = volumeIssues([r({ recent: 0 })]);
  assert.match(i.title, /No orders at all from Torino's in 7 days/);
});

test("the detail gives both numbers and where to look next", () => {
  const [i] = volumeIssues([r({ recent: 5 })]);
  assert.match(i.detail, /5 order\(s\)/);
  assert.match(i.detail, /30\.0 expected/);
  // Refused orders and absent orders are indistinguishable from here, so the
  // reader is pointed at the check that can tell them apart.
  assert.match(i.detail, /webhook_partial_rejected/);
});

console.log("it must not wake anyone:");

test("a volume collapse is a WARNING, never a critical", () => {
  // Criticals are wired to SMS. A restaurant having a bad week is a Slack
  // line and a look in the morning, not a 3am text.
  const [i] = volumeIssues([r({ recent: 0 })]);
  assert.equal(i.severity, "warning");
});

test("it produces no text message", async () => {
  const { composeSmsAlert } = await import("@/lib/alerts");
  assert.equal(composeSmsAlert(volumeIssues([r({ recent: 0 })])), null);
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

test("a collapse surfaces through evaluateHealth", () => {
  const snap = { ...bare, restaurantVolumes: [r({ recent: 0 })] };
  const keys = evaluateHealth(snap, new Date("2026-09-15T12:00:00Z")).map((i) => i.key);
  assert.ok(keys.includes("volume_collapse:r1"));
});

test("healthy volumes add nothing", () => {
  const snap = { ...bare, restaurantVolumes: [r({ recent: 31 })] };
  assert.deepEqual(evaluateHealth(snap, new Date("2026-09-15T12:00:00Z")), []);
});

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
