/**
 * Assertions for order-adjustment diffing (Zuppler amends orders after the
 * fact - see the "Order Adjusted" emails). Run via `npm test`.
 */
import assert from "node:assert/strict";
import { orderUpdateFields } from "@/lib/canonical";

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

// Mirrors the real "Order Adjusted" email: tip $0.00 -> $11.37, total moves
// with it. Postgres numeric comes back as a string, hence the quoting.
const EXISTING = {
  order_type: "delivery",
  due_time: "2026-08-10T22:30:00.000Z",
  customer_name: "Mac Baggett",
  customer_phone: "6153473239",
  customer_address: "5432 Highway 76 East",
  items: [{ name: "Clear Soup", price: "$2.50", modifiers: [] }],
  items_total: "50.25", tax: "4.90", service_fee: "14.57",
  delivery_fee: "6.06", tip: "0.00", customer_total: "75.78",
  payment_type: "CREDIT", notes: "Leave at door",
};

console.log("order adjustments:");

test("a tip added after the fact is detected", () => {
  const c = orderUpdateFields(EXISTING, { ...EXISTING, tip: 11.37, customer_total: 87.15 });
  assert.ok(c, "must detect the change");
  assert.deepEqual(Object.keys(c!).sort(), ["customer_total", "tip"]);
  assert.equal(c!.tip, 11.37);
  assert.equal(c!.customer_total, 87.15);
});

test("an unchanged re-delivery is a no-op", () =>
  assert.equal(orderUpdateFields(EXISTING, { ...EXISTING }), null));

test("numeric-as-string vs number does not create a false change", () => {
  // Postgres returns numeric as a string; the mapper produces numbers.
  const c = orderUpdateFields(EXISTING, { ...EXISTING, items_total: 50.25, tax: 4.9 });
  assert.equal(c, null, "50.25 === '50.25' must not count as a change");
});

test("sub-cent float noise is ignored", () =>
  assert.equal(orderUpdateFields(EXISTING, { ...EXISTING, customer_total: 75.7800001 }), null));

test("a missing field never erases existing data", () => {
  const c = orderUpdateFields(EXISTING, { ...EXISTING, customer_address: null, customer_phone: "" });
  assert.equal(c, null, "null/empty must not overwrite a real address or phone");
});

test("changed items are detected", () => {
  const c = orderUpdateFields(EXISTING, {
    ...EXISTING,
    items: [{ name: "Clear Soup", price: "$2.50", modifiers: ["extra hot"] }],
  });
  assert.ok(c && "items" in c);
});

test("an equivalent due_time in another format is not a change", () =>
  assert.equal(orderUpdateFields(EXISTING, { ...EXISTING, due_time: "2026-08-10T22:30:00Z" }), null));

test("a genuinely rescheduled due_time is detected", () => {
  const c = orderUpdateFields(EXISTING, { ...EXISTING, due_time: "2026-08-10T23:15:00Z" });
  assert.ok(c && "due_time" in c);
});

test("only changed columns are returned, never the whole row", () => {
  const c = orderUpdateFields(EXISTING, { ...EXISTING, notes: "Gate code 4482" });
  assert.deepEqual(Object.keys(c!), ["notes"]);
});

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
