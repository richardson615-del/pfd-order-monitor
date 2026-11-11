/**
 * Advance orders (CRM Ticket #1429): when the paper is held, when it is
 * released, what the ticket says, and the guarantees that an order can not be
 * held and then never printed. Pure: no database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADVANCE_RELEASE_STALE_MS,
  DEFAULT_ADVANCE_HOLD_MINUTES,
  advanceHoldDecision,
  advanceHoldMinutes,
  advanceReleaseDue,
  isAdvanceOrder,
} from "../lib/advance-order";
import { buildTicket, toPlainText } from "../lib/ticket";

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

const NOW = Date.parse("2026-11-10T20:30:00Z"); // 2:30 PM Central
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const tablet = { now: NOW, source: "zuppler", printMethod: "printer", appExpected: true, windowMinutes: 45 };

test("the window is 45 minutes (Nick 2026-11-10); the env can change it or switch it off", () => {
  assert.equal(DEFAULT_ADVANCE_HOLD_MINUTES, 45);
  assert.equal(advanceHoldMinutes({} as NodeJS.ProcessEnv), 45);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "60" } as unknown as NodeJS.ProcessEnv), 60);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "0" } as unknown as NodeJS.ProcessEnv), 0);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "soon" } as unknown as NodeJS.ProcessEnv), 45);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "-5" } as unknown as NodeJS.ProcessEnv), 45);
});

test("the brief's case: placed 2:30 PM for 4:30 PM at a tablet restaurant is held until 3:45 PM", () => {
  const d = advanceHoldDecision({ ...tablet, dueTime: at(120) });
  assert.deepEqual(d, { hold: true, releaseAt: at(75) });
});

test("ASAP and near orders print now, exactly as before", () => {
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: null }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: "not a time" }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(45) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(20) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(-10) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(46) }).hold, true);
});

test("a restaurant with no tablet app keeps its paper at once: paper is its only notice", () => {
  for (const appExpected of [false, null, undefined]) {
    const d = advanceHoldDecision({ ...tablet, appExpected, dueTime: at(180) });
    assert.equal(d.hold, false);
  }
  assert.equal(advanceHoldDecision({ ...tablet, printMethod: "email", dueTime: at(180) }).hold, false);
});

test("test orders, ezCater (its own lead time) and a switched-off window are never held", () => {
  assert.equal(advanceHoldDecision({ ...tablet, source: "test", dueTime: at(180) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, source: "ezcater", dueTime: at(180) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, windowMinutes: 0, dueTime: at(180) }).hold, false);
  // Phone orders the CRM placed for later are held like website ones.
  assert.equal(advanceHoldDecision({ ...tablet, source: "phone", dueTime: at(180) }).hold, true);
});

test("release: from due - 45 min, for an order that was placed for later, until 2 hours past due", () => {
  const order = { received_at: at(0), due_time: at(120) };
  assert.equal(advanceReleaseDue(order, NOW + 74 * 60_000, 45), false);
  assert.equal(advanceReleaseDue(order, NOW + 75 * 60_000, 45), true);
  // A minute the cron missed is caught by the next one, and the one after.
  assert.equal(advanceReleaseDue(order, NOW + 76 * 60_000, 45), true);
  assert.equal(advanceReleaseDue(order, NOW + 125 * 60_000, 45), true);
  assert.equal(advanceReleaseDue(order, NOW + 120 * 60_000 + ADVANCE_RELEASE_STALE_MS + 60_000, 45), false);
  // An ordinary order (due soon after it arrived) is never the sweep's business.
  assert.equal(advanceReleaseDue({ received_at: at(0), due_time: at(30) }, NOW + 10 * 60_000, 45), false);
  assert.equal(advanceReleaseDue({ received_at: at(0), due_time: null }, NOW, 45), false);
  assert.equal(advanceReleaseDue(order, NOW + 80 * 60_000, 0), false);
});

test("the ticket says ADVANCE ORDER above the due time, only for an order placed for later", () => {
  const base = { order_number: "A1", order_type: "delivery", customer_name: "C", items: [{ name: "Burger", price: 9 }] };
  const adv = toPlainText(buildTicket({ ...base, received_at: at(0), due_time: at(120) }));
  assert.match(adv, /ADVANCE ORDER/);
  assert.ok(adv.indexOf("ADVANCE ORDER") < adv.indexOf("DUE"));
  assert.doesNotMatch(toPlainText(buildTicket({ ...base, received_at: at(0), due_time: at(30) })), /ADVANCE ORDER/);
  assert.doesNotMatch(toPlainText(buildTicket({ ...base, received_at: at(0), due_time: null })), /ADVANCE ORDER/);
  // A replayed order whose due time is before it arrived stays (PAST), never ADVANCE.
  assert.doesNotMatch(toPlainText(buildTicket({ ...base, received_at: at(0), due_time: at(-60) })), /ADVANCE ORDER/);
  assert.equal(isAdvanceOrder({ received_at: at(0), due_time: at(46) }), true);
  assert.equal(isAdvanceOrder({ received_at: at(0), due_time: at(45) }), false);
});

test("guarantees in the code: any doubt prints now, the minute cron releases, a released job outlives the age rule", () => {
  const ingest = readFileSync("lib/canonical.ts", "utf8");
  // The decision is inside a try whose failure falls through to the ordinary queueing.
  assert.match(ingest, /advance hold: decision failed, printing now/);
  assert.match(ingest, /if \(hold\.hold\) \{[\s\S]{0,200}return;/);
  const cron = readFileSync("app/api/monitor/check/route.ts", "utf8");
  assert.match(cron, /advance = await releaseAdvanceOrders\(\)/);
  // The release runs before the health checks, so nothing that fails or stalls there can keep paper from a kitchen.
  assert.ok(cron.indexOf("releaseAdvanceOrders()") < cron.indexOf("collectSnapshot()"));
  const sweep = readFileSync("lib/advance-hold.ts", "utf8");
  // No schema change: a held order is one with no printer job; a job of any origin ends the sweep's interest.
  assert.match(sweep, /\.not\("device_id", "is", null\)/);
  assert.match(sweep, /manual_reprint_at: nowIso/);
  assert.doesNotMatch(sweep, /\.from\("orders"\)\s*\.update|\.delete\(/);
  // The pure half imports nothing from the database, so the ticket renderer can use it anywhere.
  assert.doesNotMatch(readFileSync("lib/advance-order.ts", "utf8"), /supabase/);
});

console.log(`\n${passed} assertions passed (advance hold).`);
