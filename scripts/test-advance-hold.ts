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
  advanceReleaseAt,
  advanceWindowMinutes,
  maxAdvanceWindowMinutes,
  isAdvanceOrder,
} from "../lib/advance-order";
import { eatabitPrinterName, isEatabitPrinterName } from "../lib/printers/text-only";
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
const tablet = { now: NOW, source: "zuppler", printMethod: "printer", windowMinutes: 60 };

test("the base window is 60 minutes (Matt 2026-11-11); the env can change it or switch it off", () => {
  assert.equal(DEFAULT_ADVANCE_HOLD_MINUTES, 60);
  assert.equal(advanceHoldMinutes({} as NodeJS.ProcessEnv), 60);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "45" } as unknown as NodeJS.ProcessEnv), 45);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "0" } as unknown as NodeJS.ProcessEnv), 0);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "soon" } as unknown as NodeJS.ProcessEnv), 60);
  assert.equal(advanceHoldMinutes({ ADVANCE_HOLD_MINUTES: "-5" } as unknown as NodeJS.ProcessEnv), 60);
});

test("larger orders go earlier: $150+ 90 min, $250+ 120 min; a missing total is the base; off stays off", () => {
  assert.equal(advanceWindowMinutes(149.99, 60), 60);
  assert.equal(advanceWindowMinutes(150, 60), 90);
  assert.equal(advanceWindowMinutes("249.99", 60), 90);
  assert.equal(advanceWindowMinutes(250, 60), 120);
  assert.equal(advanceWindowMinutes(900, 60), 120);
  assert.equal(advanceWindowMinutes(null, 60), 60);
  assert.equal(advanceWindowMinutes("n/a", 60), 60);
  assert.equal(advanceWindowMinutes(300, 0), 0);
  assert.equal(advanceWindowMinutes(300, 150), 150); // a larger base is never shortened
  assert.equal(maxAdvanceWindowMinutes(60), 120);
  assert.equal(maxAdvanceWindowMinutes(0), 0);
});

test("placed 2:30 PM for 4:30 PM: held until 3:30; $180 until 3:00; $300 sends now (due within 2 hours)", () => {
  assert.deepEqual(advanceHoldDecision({ ...tablet, dueTime: at(120) }), { hold: true, releaseAt: at(60) });
  assert.deepEqual(advanceHoldDecision({ ...tablet, customerTotal: 180, dueTime: at(120) }), { hold: true, releaseAt: at(30) });
  assert.equal(advanceHoldDecision({ ...tablet, customerTotal: 300, dueTime: at(120) }).hold, false);
  assert.deepEqual(advanceHoldDecision({ ...tablet, customerTotal: 300, dueTime: at(180) }), { hold: true, releaseAt: at(60) });
});

test("ASAP and near orders send now, exactly as before", () => {
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: null }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: "not a time" }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(60) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(20) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(-10) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, dueTime: at(61) }).hold, true);
});

test("every restaurant is held the same (Matt 2026-11-11): tablet, Eatabit, Epson and PC email", () => {
  for (const printMethod of ["printer", "email", null, undefined]) {
    assert.equal(advanceHoldDecision({ ...tablet, printMethod, dueTime: at(180) }).hold, true);
  }
});

test("test orders, ezCater (its own lead time) and a switched-off window are never held", () => {
  assert.equal(advanceHoldDecision({ ...tablet, source: "test", dueTime: at(180) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, source: "ezcater", dueTime: at(180) }).hold, false);
  assert.equal(advanceHoldDecision({ ...tablet, windowMinutes: 0, dueTime: at(180) }).hold, false);
  // Phone orders the CRM placed for later are held like website ones.
  assert.equal(advanceHoldDecision({ ...tablet, source: "phone", dueTime: at(180) }).hold, true);
});

test("release time for the CRM: due minus the order's own window, null when not held", () => {
  assert.equal(advanceReleaseAt({ received_at: at(0), due_time: at(180) }, 60), at(120));
  assert.equal(advanceReleaseAt({ received_at: at(0), due_time: at(180), customer_total: 260 }, 60), at(60));
  assert.equal(advanceReleaseAt({ received_at: at(0), due_time: at(30) }, 60), null);
  assert.equal(advanceReleaseAt({ received_at: at(0), due_time: null }, 60), null);
});

test("release: from due - the order's window, for an order placed for later, until 2 hours past due", () => {
  const order = { received_at: at(0), due_time: at(120) };
  assert.equal(advanceReleaseDue(order, NOW + 59 * 60_000, 60), false);
  assert.equal(advanceReleaseDue(order, NOW + 60 * 60_000, 60), true);
  // A minute the cron missed is caught by the next one, and the one after.
  assert.equal(advanceReleaseDue(order, NOW + 61 * 60_000, 60), true);
  assert.equal(advanceReleaseDue(order, NOW + 125 * 60_000, 60), true);
  assert.equal(advanceReleaseDue(order, NOW + 120 * 60_000 + ADVANCE_RELEASE_STALE_MS + 60_000, 60), false);
  // A $260 order placed 3 hours ahead goes at due - 2 h.
  const big = { received_at: at(0), due_time: at(180), customer_total: 260 };
  assert.equal(advanceReleaseDue(big, NOW + 59 * 60_000, 60), false);
  assert.equal(advanceReleaseDue(big, NOW + 60 * 60_000, 60), true);
  // An ordinary order (due soon after it arrived) is never the sweep's business.
  assert.equal(advanceReleaseDue({ received_at: at(0), due_time: at(30) }, NOW + 10 * 60_000, 60), false);
  assert.equal(advanceReleaseDue({ received_at: at(0), due_time: null }, NOW, 60), false);
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
  assert.equal(isAdvanceOrder({ received_at: at(0), due_time: at(61) }), true);
  assert.equal(isAdvanceOrder({ received_at: at(0), due_time: at(60) }), false);
});

test("guarantees in the code: any doubt prints now, the minute cron releases, a released job outlives the age rule", () => {
  const ingest = readFileSync("lib/canonical.ts", "utf8");
  // The decision is inside a try whose failure falls through to the ordinary queueing.
  assert.match(ingest, /advance hold: decision failed, sending now/);
  // Decided before either the PC email or the printers.
  assert.ok(ingest.indexOf("advanceHoldDecision({") < ingest.indexOf("await deliverByEmail({"));
  assert.match(ingest, /if \(hold\.hold\) \{[\s\S]{0,200}return;/);
  const cron = readFileSync("app/api/monitor/check/route.ts", "utf8");
  assert.match(cron, /advance = await releaseAdvanceOrders\(\)/);
  // The release runs before the health checks, so nothing that fails or stalls there can keep paper from a kitchen.
  assert.ok(cron.indexOf("releaseAdvanceOrders()") < cron.indexOf("collectSnapshot()"));
  const sweep = readFileSync("lib/advance-hold.ts", "utf8");
  // No schema change: a held order is one with no printer job; a job of any origin ends the sweep's interest.
  assert.match(sweep, /j\.device_id != null \|\| j\.delivery === "email"/);
  assert.match(sweep, /emailSkipReason\(restaurant, order\)/);
  const route = readFileSync("app/api/crm/orders/[id]/actions/route.ts", "utf8");
  assert.match(route, /sendOrderToKitchen\(order\.id, `advance_release:crm:\$\{actor\}`\)/);
  assert.match(sweep, /manual_reprint_at: nowIso/);
  assert.doesNotMatch(sweep, /\.from\("orders"\)\s*\.update|\.delete\(/);
  // The pure half imports nothing from the database, so the ticket renderer can use it anywhere.
  assert.doesNotMatch(readFileSync("lib/advance-order.ts", "utf8"), /supabase/);
});

test("an Eatabit names itself from its User-Agent; nothing else does", () => {
  assert.equal(eatabitPrinterName("pfd-eatabit/2.5.0"), "PFD Eatabit 2.5.0");
  assert.equal(eatabitPrinterName("pfd-eatabit"), "PFD Eatabit");
  assert.equal(eatabitPrinterName("EpsonTM-m30III"), null);
  assert.equal(eatabitPrinterName(null), null);
  assert.equal(isEatabitPrinterName("PFD Eatabit 2.5.0"), true);
  assert.equal(isEatabitPrinterName("TM-m30III"), false);
  assert.equal(isEatabitPrinterName(null), false);
});

console.log(`\n${passed} assertions passed (advance hold).`);
