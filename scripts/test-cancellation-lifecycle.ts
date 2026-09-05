/**
 * Cancellation must not falsify revenue.
 *
 * Seven real orders worth $156.34 printed and were then cancelled upstream -
 * one of them eleven hours later. They sat inside the accounting totals,
 * because the query filtered only on source. These assertions exist so that
 * cannot happen again quietly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const accounting = readFileSync("app/api/crm/accounting/orders/route.ts", "utf8");
const ingest = readFileSync("lib/zuppler-ingest.ts", "utf8");

console.log("cancellation lifecycle:");

test("revenue totals are computed from BILLABLE orders only", () => {
  assert.match(accounting, /const billable = rows\.filter\(\(r\) => !r\.cancelled\)/);
  assert.match(accounting, /const sum = \(f: \(r: any\) => number \| null\) => sumOf\(billable, f\)/);
});

test("cancelled orders are still returned, not dropped", () => {
  // Hiding them would repeat the original mistake in the other direction: a
  // cancellation after printing cost somebody something.
  assert.match(accounting, /cancelled: \{/);
  assert.match(accounting, /order_ids: cancelled\.map/);
});

test("printed-then-cancelled is distinguishable from cancelled in time", () => {
  assert.match(accounting, /cancelled_after_print/);
  assert.match(accounting, /after_print_total/);
});

test("the response says how many orders the totals actually cover", () =>
  // A consumer must not have to infer it from count minus something.
  assert.match(accounting, /billable_count/));

test("printed_at is NEVER cleared by a cancellation", () => {
  // A ticket that came out of a printer is a fact about the world. Erasing it
  // makes a cancelled-after-printing order look like one that never reached
  // the kitchen.
  const cancelBlock = ingest.slice(ingest.indexOf("if (mapped.state && /cancel/"), ingest.indexOf("return { status: \"cancelled\""));
  assert.ok(!/printed_at:\s*null/.test(cancelBlock));
  assert.match(cancelBlock, /status: "cancelled", cancelled_at: now/);
});

test("cancelling an already-printed order is logged loudly", () => {
  assert.match(ingest, /CANCELLED AFTER PRINTING/);
  assert.match(ingest, /console\.error/);
});

test("a cancellation still kills unclaimed tickets", () =>
  // The operational half must survive the accounting fix.
  assert.match(ingest, /\.in\("status", \["queued", "claimed"\]\)/));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
