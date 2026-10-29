/**
 * Scheduled (future-dated) orders on the tablet (SC1, Nick 2026-10-29).
 *
 * Willie Mae's ezCater #GJ3P08 reached the kitchen 24 h before it was due
 * and read like a late order for today: a red age counting up from arrival,
 * and six hours in it would have dropped off the Orders list. These pin the
 * pure rules: what is scheduled, which list it is in, its clocks, its sort,
 * its countdown, the due label, the office alert and the CRM's flags.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SCHEDULED_AHEAD_MS,
  ageClass,
  ageMs,
  arrivedAhead,
  bucketOf,
  dueLabel,
  elapsedLabel,
  isLate,
  isScheduled,
  kitchenClockStart,
} from "../lib/order-display";
import { countdown, heroSummary, kitchenSort } from "../lib/countdown";
import { unaccepted } from "../lib/kiosk";
import { evaluateHealth, type HealthSnapshot } from "../lib/health";
import { orderFlags, sortOrderRows } from "../lib/crm-orders";
import { AGE_LATE_MS } from "../lib/order-display";

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
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const H = 3_600_000;
const TZ = "America/Chicago";
// Thu 29 Oct 2026 12:00 Central = 17:00Z. GJ3P08 is due Fri 30 Oct 11:30 Central = 16:30Z, sent to the kitchen 24 h before.
const NOW = Date.parse("2026-10-29T17:00:00Z");
const DUE = "2026-10-30T16:30:00Z";
const RECEIVED = "2026-10-29T16:30:00Z";
const catering = (over: Record<string, unknown> = {}) =>
  ({ id: "gj3p08", status: "new", received_at: RECEIVED, due_time: DUE, accepted_at: null, completed_at: null, cancelled_at: null, ready_by: null, ready_at: null, ...over }) as any;
const ordinary = (over: Record<string, unknown> = {}) =>
  ({ id: "o1", status: "new", received_at: new Date(NOW - 3 * 60_000).toISOString(), due_time: new Date(NOW + 40 * 60_000).toISOString(), accepted_at: null, completed_at: null, cancelled_at: null, ...over }) as any;

console.log("what is scheduled:");
test("due tomorrow: scheduled; due in 90 min: ordinary; the line is 2 h", () => {
  assert.equal(SCHEDULED_AHEAD_MS, 2 * H);
  assert.equal(isScheduled(catering(), NOW), true);
  assert.equal(isScheduled(catering({ due_time: new Date(NOW + 90 * 60_000).toISOString() }), NOW), false);
  assert.equal(isScheduled(ordinary(), NOW), false);
});
test("settled is never scheduled; a missing or unreadable due time is ordinary", () => {
  assert.equal(isScheduled(catering({ status: "completed" }), NOW), false);
  assert.equal(isScheduled(catering({ status: "cancelled" }), NOW), false);
  assert.equal(isScheduled(catering({ due_time: null }), NOW), false);
  assert.equal(isScheduled(catering({ due_time: "Friday" }), NOW), false);
  assert.equal(arrivedAhead(catering({ due_time: "Friday" })), false);
  assert.equal(kitchenClockStart(catering({ due_time: null })), RECEIVED);
});

console.log("\nthe list and the clocks:");
test("in Orders at arrival, +7 h and +20 h (it used to fall off at +6 h); Past only 6 h after it is due", () => {
  for (const h of [0, 7, 20, 23.9]) assert.equal(bucketOf(catering(), NOW + h * H, TZ), "orders", `at +${h} h`);
  const due = Date.parse(DUE);
  assert.equal(bucketOf(catering(), due + 5 * H, TZ), "orders");
  assert.equal(bucketOf(catering(), due + 6 * H + 1, TZ), "past");
});
test("while scheduled: age 0, calm, never late, whatever the hour", () => {
  // NOW is 23.5 h before due, so it is scheduled until NOW + 21.5 h.
  for (const h of [0, 1, 12, 21.4]) {
    const now = NOW + h * H;
    assert.equal(ageMs(catering(), now), 0);
    assert.equal(ageClass(catering(), now), "age-calm");
    assert.equal(isLate(catering(), now), false);
  }
});
test("becomes an ordinary order 2 h before due, its age counted from there", () => {
  const start = Date.parse(DUE) - 2 * H;
  assert.equal(kitchenClockStart(catering()), new Date(start).toISOString());
  assert.equal(isScheduled(catering(), start + 1), false);
  assert.equal(ageMs(catering(), start + 11 * 60_000), 11 * 60_000);
  assert.equal(elapsedLabel(catering(), start + 11 * 60_000), "11:00");
  assert.equal(isLate(catering(), start + AGE_LATE_MS), true);
});
test("an ordinary order's clock is unchanged: received_at", () => {
  assert.equal(kitchenClockStart(ordinary()), ordinary().received_at);
  assert.equal(ageMs(ordinary(), NOW), 3 * 60_000);
});

console.log("\nsort, countdown and hero:");
test("scheduled sorts after today's work (accepted or not), soonest due first", () => {
  const later = catering({ id: "later", due_time: "2026-10-31T16:30:00Z" });
  const sorted = kitchenSort([later, catering(), ordinary({ accepted_at: new Date(NOW - 60_000).toISOString() }), ordinary({ id: "o2" })], 25, NOW);
  assert.deepEqual(sorted.map((o) => o.id), ["o2", "o1", "gj3p08", "later"]);
});
test("accepted while scheduled: no countdown; 2 h before due it counts down to the hand-off (ready_by = due_time)", () => {
  const acc = catering({ accepted_at: new Date(NOW).toISOString(), ready_by: DUE });
  assert.equal(countdown(acc, 25, NOW), null);
  assert.equal(countdown(acc, 25, NOW + 21 * H), null);
  const cd = countdown(acc, 25, Date.parse(DUE) - 90 * 60_000);
  assert.ok(cd);
  assert.equal(cd!.dueAt, Date.parse(DUE));
  assert.equal(cd!.phase, "calm");
});
test("the hero line never goes late for a scheduled order waiting for Accept", () => {
  assert.equal(heroSummary([catering()], 25, NOW + 3 * H, AGE_LATE_MS).tone, "busy");
});
test("it still chimes on arrival until Accept (the chime is the acknowledgement it asks for)", () => {
  assert.equal(unaccepted([catering()], NOW).length, 1);
  assert.equal(unaccepted([catering({ accepted_at: new Date(NOW).toISOString() })], NOW).length, 0);
});

console.log("\nthe due label:");
test("Today / Tomorrow / weekday, in the restaurant's zone", () => {
  assert.equal(dueLabel(DUE, NOW, TZ), "Tomorrow 11:30 AM");
  assert.equal(dueLabel("2026-10-29T23:00:00Z", NOW, TZ), "Today 6:00 PM");
  assert.equal(dueLabel("2026-10-31T16:30:00Z", NOW, TZ), "Sat, Oct 31 · 11:30 AM");
  assert.equal(dueLabel(null, NOW, TZ), "");
  assert.equal(dueLabel("not a time", NOW, TZ), "");
});
test("Tomorrow across the DST change (Sat 31 Oct -> Sun 1 Nov 2026 in Central)", () => {
  assert.equal(dueLabel("2026-11-01T17:30:00Z", Date.parse("2026-10-31T17:00:00Z"), TZ), "Tomorrow 11:30 AM");
});

console.log("\nthe office and the CRM:");
const snap = (o: Record<string, unknown>) =>
  ({ unacceptedOrders: [{ id: "gj3p08", order_number: "GJ3P08", restaurant_id: "r1", restaurant_name: "Willie Mae's", ...o }] }) as any;
const unacceptedIssue = (o: Record<string, unknown>, now: number) =>
  evaluateHealth({ ...emptySnapshot(), ...snap(o) }, new Date(now)).find((i: { key: string }) => i.key === "order_unaccepted:gj3p08");
test("a scheduled order not acknowledged is a WARNING that says when it is for - never 'the customer is waiting'", () => {
  const i = unacceptedIssue({ received_at: RECEIVED, due_time: DUE }, NOW);
  assert.ok(i);
  assert.equal(i!.severity, "warning");
  assert.match(i!.detail, /Catering order for Tomorrow 11:30 AM not acknowledged on the tablet/);
  assert.doesNotMatch(i!.detail, /customer is waiting/);
});
test("an ordinary unaccepted order is still critical", () => {
  const i = unacceptedIssue({ received_at: new Date(NOW - 20 * 60_000).toISOString(), due_time: null }, NOW);
  assert.equal(i?.severity, "critical");
});
test("CRM flags: a scheduled order is not 'unaccepted over 3 min' or late; it lists after today's work", () => {
  const f = orderFlags(catering() as any, 25, NOW + 3 * H);
  assert.equal(f.unaccepted_over_3m, false);
  assert.equal(f.late, false);
  const rows = sortOrderRows([{ ...catering(), prep_minutes: 25 }, { ...ordinary(), prep_minutes: 25 }] as any, NOW);
  assert.deepEqual(rows.map((r: any) => r.id), ["o1", "gj3p08"]);
});

console.log("\nthe screens and the accept route:");
test("Accept on a scheduled order writes ready_by = due_time and no minutes", () => {
  const route = src("app/api/orders/[id]/route.ts");
  assert.match(route, /isScheduled\(order, Date\.now\(\)\)/);
  assert.match(route, /readyBy = new Date\(order\.due_time\)\.toISOString\(\)/);
  assert.match(route, /ready_by: readyBy/);
});
test("the card shows Scheduled + Due, a plain Accept, and hides minute picks, Ready and +5/+10", () => {
  const card = src("components/OrderCard.tsx");
  assert.match(card, /card-flag scheduled/);
  assert.match(card, /Due \{dueLabel\(order\.due_time, now, timezone\)\}/);
  assert.match(card, /scheduled \? "Accept" :/);
  assert.match(card, /\{!scheduled && <div className="card-minutes"/);
  assert.match(card, /!scheduled && cd !== null/);
  const viewer = src("components/OrderViewer.tsx");
  assert.match(viewer, /ticket-scheduled/);
  assert.match(viewer, /waiting && !scheduled/);
  assert.match(src("components/OrderDashboard.tsx"), /app-divider scheduled/);
});

function emptySnapshot(): HealthSnapshot {
  // test-health.ts's healthy system, minus its devices and inboxes: nothing else raises an issue.
  const at = new Date(NOW - 60_000).toISOString();
  return {
    devices: [],
    inboxes: [],
    restaurantsWithoutDevice: [],
    pendingJobs: [],
    failedJobs: [],
    unreconciledOrders: [],
    unsentEmailJobs: [],
    undeliveredAppAlerts: [],
    restaurantsWithoutAppDevice: [],
    tabletsNotWatching: [],
    unacceptedOrders: [],
    webhook: { lastReceiptAt: at, lastAcceptedAt: at, recentTotal: 3, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] },
    cronRuns: [
      { job: "gmail_poll", last_run_at: at },
      { job: "monitor_check", last_run_at: at },
    ],
    restaurantVolumes: [],
  } as HealthSnapshot;
}

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
