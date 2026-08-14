/**
 * Assertions for SMS alert composition. SMS costs money per segment and
 * interrupts someone, so what gets sent - and what deliberately does not -
 * is worth pinning down.
 */
import assert from "node:assert/strict";
import { composeSmsAlert, smsRecipients } from "@/lib/alerts";
import type { HealthIssue } from "@/lib/health";

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

const critical = (n: number): HealthIssue => ({
  key: `k${n}`,
  severity: "critical",
  title: `Printer offline: Kitchen ${n}`,
  detail: `Restaurant ${n} - last checked in 30 min ago. Orders will not print.`,
});
const warning: HealthIssue = {
  key: "w1",
  severity: "warning",
  title: "No printer: Depot Bar and Grill",
  detail: "Orders will be recorded but never printed.",
};

console.log("what earns a text:");

test("nothing at all sends nothing", () =>
  assert.equal(composeSmsAlert([]), null));

test("warnings alone never send a text", () =>
  assert.equal(composeSmsAlert([warning]), null, "a warning must not wake someone"));

test("one critical sends the title and the detail", () => {
  const t = composeSmsAlert([critical(1)])!;
  assert.match(t, /Printer offline: Kitchen 1/);
  assert.match(t, /Orders will not print/);
});

test("warnings are filtered out of a mixed batch", () => {
  const t = composeSmsAlert([warning, critical(1)])!;
  assert.ok(!/Depot/.test(t), "the warning must not appear");
  assert.match(t, /Kitchen 1/);
});

console.log("bursts stay one message:");

test("several criticals become a single summary, not several texts", () => {
  const t = composeSmsAlert([critical(1), critical(2), critical(3)])!;
  assert.match(t, /^PFD Order Monitor: 3 critical issues\./);
});

test("a large burst is capped and reports the remainder", () => {
  const many = Array.from({ length: 20 }, (_, i) => critical(i + 1));
  const t = composeSmsAlert(many)!;
  assert.match(t, /\+\d+ more/, "must say how many were omitted");
  assert.match(t, /^PFD Order Monitor: 20 critical issues\./, "count must be the true total");
});

test("no message exceeds two SMS segments", () => {
  for (const n of [1, 2, 5, 20, 100]) {
    const t = composeSmsAlert(Array.from({ length: n }, (_, i) => critical(i + 1)))!;
    assert.ok(t.length <= 300, `${n} issues produced ${t.length} chars`);
  }
});

test("a single very long issue is truncated, not sent whole", () => {
  const huge: HealthIssue = { ...critical(1), detail: "x".repeat(1000) };
  const t = composeSmsAlert([huge])!;
  assert.ok(t.length <= 300);
  assert.match(t, /…$/);
});

console.log("recipients:");

test("recipients parse from comma or space separated lists", () => {
  process.env.ALERT_SMS_TO = "+15551234567, +15557654321  +15550000000";
  try {
    assert.deepEqual(smsRecipients(), ["+15551234567", "+15557654321", "+15550000000"]);
  } finally {
    delete process.env.ALERT_SMS_TO;
  }
});

test("no recipients configured yields an empty list, not a crash", () => {
  delete process.env.ALERT_SMS_TO;
  assert.deepEqual(smsRecipients(), []);
});

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
