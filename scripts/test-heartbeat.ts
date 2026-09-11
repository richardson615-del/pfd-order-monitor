/**
 * "Is anybody actually watching that tablet?"
 *
 * The last failure the other checks were blind to. A push subscription
 * belongs to the browser's service worker, not to the session, so it outlives
 * being signed out: a tablet sits on a login screen, push keeps reporting
 * delivered, and every check reads green while nobody sees a single order.
 *
 * The hard part is not detecting it. It is detecting it without firing at
 * four in the morning, every morning, at a restaurant that simply closed and
 * switched its tablet off - which is how a channel gets muted before the
 * night it matters.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_THRESHOLDS,
  evaluateHealth,
  type HealthSnapshot,
} from "@/lib/health";
import { HEARTBEAT_EVERY_MS } from "@/lib/kiosk";

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

const NOW = new Date("2026-09-11T19:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

const quiet: HealthSnapshot = {
  devices: [],
  inboxes: [],
  restaurantsWithoutDevice: [],
  restaurantsWithoutAppDevice: [],
  tabletsNotWatching: [],
  pendingJobs: [],
  failedJobs: [],
  unreconciledOrders: [],
  unsentEmailJobs: [],
  undeliveredAppAlerts: [],
  webhook: { lastReceiptAt: null, lastAcceptedAt: null, recentTotal: 0, recentRejected: 0 },
};

const tablet = (over: Partial<HealthSnapshot["tabletsNotWatching"][number]> = {}) => ({
  id: "r1",
  name: "China One",
  lastSeenAt: minsAgo(40),
  lastOrderAt: minsAgo(5),
  ...over,
});

console.log("catching it:");

test("orders arriving with no screen open is critical", () => {
  const issues = evaluateHealth({ ...quiet, tabletsNotWatching: [tablet()] }, NOW);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "tablet_not_watching:r1");
  assert.equal(issues[0].severity, "critical");
});

test("it explains why nothing else caught it", () => {
  const issues = evaluateHealth({ ...quiet, tabletsNotWatching: [tablet()] }, NOW);
  assert.match(issues[0].detail, /push still reports delivered/i);
});

test("a screen that has NEVER checked in reads as never, not as a duration", () => {
  const issues = evaluateHealth({ ...quiet, tabletsNotWatching: [tablet({ lastSeenAt: null })] }, NOW);
  assert.equal(issues.length, 1);
  assert.match(issues[0].detail, /at any point/);
});

test("each restaurant is its own issue, so two do not hide each other", () => {
  const issues = evaluateHealth(
    {
      ...quiet,
      tabletsNotWatching: [tablet(), tablet({ id: "r2", name: "Swezey's Pub" })],
    },
    NOW
  );
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((i) => i.key).sort(),
    ["tablet_not_watching:r1", "tablet_not_watching:r2"]
  );
});

console.log("\nstaying quiet when it should:");

test("a screen that checked in recently is fine", () =>
  assert.deepEqual(
    evaluateHealth({ ...quiet, tabletsNotWatching: [tablet({ lastSeenAt: minsAgo(3) })] }, NOW),
    []
  ));

test("ordinary timer throttling cannot trip it", () => {
  // Beats every 2 minutes against a 15 minute threshold, so a browser
  // throttling a backgrounded tab has to miss seven in a row.
  assert.deepEqual(
    evaluateHealth(
      {
        ...quiet,
        tabletsNotWatching: [
          tablet({ lastSeenAt: minsAgo(DEFAULT_THRESHOLDS.tabletSilentMinutes - 1) }),
        ],
      },
      NOW
    ),
    []
  );
  assert.ok(
    HEARTBEAT_EVERY_MS * 7 <= DEFAULT_THRESHOLDS.tabletSilentMinutes * 60_000,
    "seven missed beats must still be inside the threshold"
  );
});

test("a closed restaurant is never reported", () => {
  // The gate that makes this liveable. No recent order means the collector
  // never includes the restaurant, so a tablet switched off overnight raises
  // nothing. Without it this fires every morning, and then gets muted.
  assert.deepEqual(evaluateHealth({ ...quiet, tabletsNotWatching: [] }, NOW), []);
});

console.log("\nthe collector's own gate:");

const health = readFileSync(new URL("../lib/health.ts", import.meta.url), "utf8");

test("only restaurants on the app are considered", () =>
  assert.match(health, /r\.is_active && r\.app_expected/));

test("a restaurant with no recent order is skipped entirely", () => {
  assert.match(health, /if \(!orderAt\) continue/);
  assert.match(health, /tabletOrderWindowMinutes/);
});

test("the newest order wins, since the query is newest-first", () =>
  assert.match(health, /if \(!lastOrder\.has\(o\.restaurant_id\)\)/));

test("an unreadable heartbeat table skips the check rather than accusing everyone", () => {
  // Without this, a failed read makes every restaurant look like it has never
  // checked in - a critical apiece, all at once. "We could not tell" is not
  // "nobody is watching", and a check that cries wolf when its own table is
  // unreachable is one people mute.
  assert.match(health, /if \(beatsError\)/);
  assert.match(health, /skipping the not-watching check/);
});

console.log("\nthe table:");

const migration = readFileSync(
  new URL("../db/migrations/024_dashboard_heartbeat.sql", import.meta.url),
  "utf8"
);

test("row level security is on, with no policies", () => {
  // Nothing legitimate touches this with an anon or authenticated key - both
  // the write and the read go through the service role, which bypasses RLS.
  // So no policy is missing; the absence of one IS the rule, and it denies
  // every client. Without the line the table is readable by anyone holding
  // the anon key, which for rows saying which restaurants are open and what
  // device is on their wall is more than nothing.
  assert.match(migration, /enable row level security/);
  assert.doesNotMatch(migration, /create policy/i);
});

console.log("\nthe endpoint:");

const route = readFileSync(
  new URL("../app/api/dashboard/heartbeat/route.ts", import.meta.url),
  "utf8"
);

test("the restaurant comes from the session, never the request body", () => {
  // A heartbeat a client could address to any restaurant would let one
  // signed-in device vouch for a tablet on the other side of the state -
  // exactly the lie this exists to detect.
  // That it never READS one, not that the word is absent - the comment above
  // the handler explains the rule, and a test tripping over its own
  // explanation is pushing back on documentation rather than behaviour.
  assert.match(route, /getCurrentUserRestaurantIds\(\)/);
  assert.doesNotMatch(route, /req\.json\(\)/);
});

test("it refuses an unauthenticated caller", () =>
  assert.match(route, /status: 401/));

test("a failed write never fails the caller", () => {
  assert.match(route, /heartbeat not recorded/);
  assert.doesNotMatch(route, /status: 500/);
});

console.log(`\n${passed} assertions passed.`);
