/**
 * The Stats tab's rules (lib/scoreboard.ts).
 *
 * Worth asserting: accept time is arrival-to-Accept and ignores a tablet
 * that was off for hours; cancelled and test orders score nothing; a streak
 * breaks on one slow order but not on one that just landed; points and
 * levels add up; the daily goal comes from this weekday's own history; and
 * every day is the restaurant's day, not UTC's.
 */
import assert from "node:assert/strict";
import {
  ACCEPT_OUTLIER_SECONDS,
  LEVEL_NAMES,
  POINTS_PER_LEVEL,
  acceptSeconds,
  buildScoreboard,
  countsForScore,
  formatSeconds,
  levelOf,
  pointsFor,
  streaks,
  weekdayOf,
  type ScoreOrder,
} from "@/lib/scoreboard";

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

const TZ = "America/Chicago";
// Tue 2026-10-06 18:00 Central = 23:00 UTC
const NOW = Date.parse("2026-10-06T23:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 3600_000;

function order(receivedMsAgo: number, acceptAfterSec: number | null, extra: Partial<ScoreOrder> = {}): ScoreOrder {
  const r = NOW - receivedMsAgo;
  return {
    received_at: iso(r),
    accepted_at: acceptAfterSec === null ? null : iso(r + acceptAfterSec * 1000),
    status: "completed",
    source: "zuppler",
    customer_total: 20,
    ...extra,
  };
}

console.log("scoreboard");

test("accept time is arrival to Accept, never negative, null when not accepted", () => {
  assert.equal(acceptSeconds(order(10 * MIN, 45)), 45);
  assert.equal(acceptSeconds(order(10 * MIN, null)), null);
  const backwards = { ...order(10 * MIN, 0), accepted_at: iso(NOW - 11 * MIN) };
  assert.equal(acceptSeconds(backwards), 0);
});

test("an accept hours later is a tablet that was off, not a slow cook", () => {
  assert.equal(acceptSeconds(order(5 * 3600_000, ACCEPT_OUTLIER_SECONDS + 1)), null);
});

test("cancelled and test orders score nothing", () => {
  assert.equal(countsForScore({ status: "cancelled", source: "zuppler" }), false);
  assert.equal(countsForScore({ status: "completed", source: "test" }), false);
  assert.equal(pointsFor(order(MIN, 10, { status: "cancelled" })), 0);
  assert.equal(pointsFor(order(MIN, 10, { source: "test" })), 0);
});

test("points: 10 an order, +5 under a minute, +3 under two", () => {
  assert.equal(pointsFor(order(MIN, 30)), 15);
  assert.equal(pointsFor(order(MIN, 100)), 13);
  assert.equal(pointsFor(order(MIN, 400)), 10);
  assert.equal(pointsFor(order(20 * MIN, null)), 10);
});

test("levels every POINTS_PER_LEVEL, names run out into numbered Legends", () => {
  assert.deepEqual(levelOf(0), { level: 1, levelName: LEVEL_NAMES[0], intoLevel: 0 });
  assert.equal(levelOf(POINTS_PER_LEVEL - 1).level, 1);
  assert.equal(levelOf(POINTS_PER_LEVEL).level, 2);
  assert.equal(levelOf(POINTS_PER_LEVEL * 2 + 50).intoLevel, 50);
  const past = levelOf(POINTS_PER_LEVEL * (LEVEL_NAMES.length + 1));
  assert.match(past.levelName, /^Legend \d+$/);
});

test("streak: one slow order ends the current run; best remembers the longer one", () => {
  const list = [
    order(1 * MIN * 10, 30),
    order(2 * MIN * 10, 50),
    order(3 * MIN * 10, 500), // slow - breaks
    order(4 * MIN * 10, 20),
    order(5 * MIN * 10, 20),
    order(6 * MIN * 10, 20),
  ];
  assert.deepEqual(streaks(list, NOW), { current: 2, best: 3 });
});

test("streak: a ticket that just landed does not break the run", () => {
  const list = [order(30_000, null, { status: "new" }), order(10 * MIN, 30), order(20 * MIN, 30)];
  assert.equal(streaks(list, NOW).current, 2);
});

test("streak: a ticket ignored past two minutes does break it", () => {
  const list = [order(5 * MIN, null, { status: "new" }), order(10 * MIN, 30)];
  assert.equal(streaks(list, NOW).current, 0);
});

test("today is the restaurant's day, not UTC's", () => {
  // 00:30 UTC on Oct 7 is still Oct 6 in Chicago.
  const late = Date.parse("2026-10-07T00:30:00Z");
  const b = buildScoreboard([{ ...order(0, 30), received_at: iso(late - 5 * MIN), accepted_at: iso(late - 4 * MIN) }], late, TZ);
  assert.equal(b.today.orders, 1);
  assert.equal(b.week[b.week.length - 1].label, "Today");
});

test("today: count, sales, typical and fastest accept, share under two minutes", () => {
  const b = buildScoreboard([order(10 * MIN, 30), order(20 * MIN, 90), order(30 * MIN, 300), order(40 * MIN, null, { status: "cancelled" })], NOW, TZ);
  assert.equal(b.today.orders, 3);
  assert.equal(b.today.sales, 60);
  assert.equal(b.today.accepted, 3);
  assert.equal(b.today.typicalAcceptSeconds, 90);
  assert.equal(b.today.fastestAcceptSeconds, 30);
  assert.equal(Math.round((b.today.fastShare ?? 0) * 100), 67);
});

test("goal: beat this weekday's recent average; a starter goal with no history", () => {
  const history = [
    ...Array.from({ length: 8 }, (_, i) => order(7 * DAY + i * MIN, 30)),
    ...Array.from({ length: 12 }, (_, i) => order(14 * DAY + i * MIN, 30)),
  ];
  const b = buildScoreboard([...history, order(MIN * 3, 20)], NOW, TZ);
  assert.equal(b.goal.target, 11); // avg(8, 12) = 10, +1
  assert.equal(b.goal.done, 1);
  assert.match(b.goal.basis, /Tuesday/);
  const fresh = buildScoreboard([order(MIN * 3, 20)], NOW, TZ);
  assert.equal(fresh.goal.basis, "Starter goal");
});

test("week bars: seven days, oldest first, with the same weekday a week back", () => {
  const b = buildScoreboard([order(7 * DAY + MIN, 30), order(MIN, 30), order(2 * MIN, 30)], NOW, TZ);
  assert.equal(b.week.length, 7);
  const t = b.week[6];
  assert.equal(t.label, "Today");
  assert.equal(t.count, 2);
  assert.equal(t.lastWeek, 1);
});

test("badges carry their rule and earn on it", () => {
  const ten = Array.from({ length: 10 }, (_, i) => order((i + 1) * 5 * MIN, 30));
  const b = buildScoreboard(ten, NOW, TZ);
  const by = Object.fromEntries(b.badges.map((x) => [x.key, x]));
  assert.equal(by.lightning.earned, true);
  assert.equal(by["perfect-shift"].earned, true);
  assert.equal(by["fast-hands"].earned, true);
  assert.equal(by.century.earned, false);
  assert.equal(by.century.progressLabel, "10 / 100");
  for (const x of b.badges) assert.ok(x.rule.length > 10, `${x.key} has a rule`);
});

test("month points only count this month", () => {
  // Oct 6 now; an order on Sep 30 is last month.
  const lastMonth = order(6 * DAY + 2 * 3600_000, 30);
  const b = buildScoreboard([lastMonth, order(MIN, 30)], NOW, TZ);
  assert.equal(b.points.month, 15);
  assert.equal(b.points.today, 15);
});

test("formatting", () => {
  assert.equal(formatSeconds(42), "42s");
  assert.equal(formatSeconds(65), "1:05");
  assert.equal(weekdayOf("2026-10-06"), "Tuesday");
});

console.log(`\n${passed} passed`);
