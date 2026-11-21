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
import { cancelNoticeFor } from "../lib/cancel-mark";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const accounting = readFileSync("app/api/crm/accounting/orders/route.ts", "utf8");
const ingest = readFileSync("lib/zuppler-ingest.ts", "utf8");
const mark = readFileSync("lib/cancel-mark.ts", "utf8");

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
  assert.match(cancelBlock, /markOrderCancelled\(existing\.id, now\)/);
  assert.ok(!/printed_at|completed_at:\s*null/.test(mark.slice(mark.indexOf(".update("), mark.indexOf(".select("))));
  assert.match(mark, /status: "cancelled", cancelled_at: now/);
});

// Depot #340 (2026-11-20): one cancel printed twice, an hour after the kitchen finished the order.
test("a cancel notice prints once, and never for an order already completed", () => {
  assert.equal(cancelNoticeFor(true, null), "send");
  assert.equal(cancelNoticeFor(false, null), "already_cancelled");
  assert.equal(cancelNoticeFor(true, "2026-11-21T01:05:27Z"), "already_completed");
  assert.equal(cancelNoticeFor(false, "2026-11-21T01:05:27Z"), "already_cancelled");
  // Only the first caller wins: the update is guarded on cancelled_at being empty.
  assert.match(mark, /\.is\("cancelled_at", null\)/);
});

test("every cancel path goes through the guard before emailing the kitchen", () => {
  for (const f of ["lib/zuppler-ingest.ts", "lib/order-cancel.ts", "lib/ezcater-promote.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /markOrderCancelled\(/, f);
    assert.match(src, /if \(notice === "send"\) await sendCancellationEmail\(/, f);
    assert.ok(!/update\(\{ status: "cancelled", cancelled_at: now \}\)/.test(src), `${f} still cancels without the guard`);
  }
});

test("cancelling an already-printed order is logged loudly", () => {
  assert.match(ingest, /CANCELLED AFTER PRINTING/);
  assert.match(ingest, /console\.error/);
});

test("a cancellation still kills unclaimed tickets", () =>
  // The operational half must survive the accounting fix.
  assert.match(ingest, /\.in\("status", \["queued", "claimed"\]\)/));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
