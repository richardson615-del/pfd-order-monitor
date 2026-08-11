/**
 * Assertions for subject -> order number extraction.
 * Run via `npm test`.
 */
import assert from "node:assert/strict";
import { extractOrderNumberFromSubject } from "@/lib/parser";

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

console.log("subject -> order number:");

test("plain order subject", () =>
  assert.equal(extractOrderNumberFromSubject("Order 1195"), "1195"));

test("case insensitive", () =>
  assert.equal(extractOrderNumberFromSubject("ORDER 42"), "42"));

test("trailing text after the number is fine", () =>
  assert.equal(extractOrderNumberFromSubject("Order 1195 - Yummy Johns"), "1195"));

// Forwarding a real ticket is the normal way to test and to re-send a missed
// order, and Gmail prefixes the subject. These must not be silently dropped.
test("forwarded subject (Fwd:)", () =>
  assert.equal(extractOrderNumberFromSubject("Fwd: Order 1195"), "1195"));

test("forwarded subject (Fw:)", () =>
  assert.equal(extractOrderNumberFromSubject("Fw: Order 1195"), "1195"));

test("replied subject (Re:)", () =>
  assert.equal(extractOrderNumberFromSubject("Re: Order 1195"), "1195"));

test("stacked prefixes", () =>
  assert.equal(extractOrderNumberFromSubject("Re: Fwd: Order 1195"), "1195"));

test("custom pattern still honoured", () =>
  assert.equal(
    extractOrderNumberFromSubject("Fwd: Ticket #778", "^Ticket\\s+#(\\d+)"),
    "778"
  ));

test("non-order subject returns null", () =>
  assert.equal(extractOrderNumberFromSubject("Your weekly summary"), null));

test("order word without a number returns null", () =>
  assert.equal(extractOrderNumberFromSubject("Order confirmation"), null));

test("empty/garbage input does not throw", () => {
  assert.equal(extractOrderNumberFromSubject(""), null);
  assert.equal(extractOrderNumberFromSubject(undefined as unknown as string), null);
});

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
