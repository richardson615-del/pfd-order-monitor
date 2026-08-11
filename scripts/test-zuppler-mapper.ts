/**
 * Assertion-based tests for the Zuppler GraphQL -> canonical mapper.
 * Run with:  npm test   (which runs `tsx scripts/test-zuppler-mapper.ts`)
 * Exits non-zero on the first failing suite so CI catches regressions.
 */
import assert from "node:assert/strict";
import { mapZupplerGraphqlOrder } from "@/lib/zuppler-mapper";

// Make money() deterministic regardless of the ambient shell/CI env.
// (money() reads process.env.ZUPPLER_AMOUNTS on every call.)
delete process.env.ZUPPLER_AMOUNTS;

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

// Simulated LoadOrder GraphQL response matching Zuppler's documented shape.
const resp = {
  data: {
    order: {
      uuid: "ed6add77-5b2e-40db-afb5-d64143e13abe",
      shortUuid: "5de2ecfc",
      state: "confirmed",
      pickupTime: null,
      deliveryTime: "2026-08-10T22:30:00Z",
      dueTime: "2026-08-10T22:30:00Z",
      createdAt: "2026-08-10T21:47:12Z",
      // total INCLUDES the tip. Verified against a real Zuppler receipt
      // (order #7c753db5): 50.25 + 6.06 + 14.57 + 4.90 + 11.37 = 87.15.
      // 2700 + 399 + 150 + 257 + 500 = 4006.
      totals: {
        delivery: 399, discount: 0, includedTax: 0, service: 150,
        subtotal: 2700, tax: 257, tip: 500, total: 4006,
      },
      carts: [{
        restaurantId: 8841,
        comments: "Gate code 4482",
        instructions: "Leave at door",
        settings: { service: { id: "DELIVERY" }, tender: { id: "CREDIT" } },
        customer: { name: "Jane Doe", email: "jane@example.com", phone: "615-555-0100" },
        items: [
          { id: 1, name: "Cheeseburger", quantity: 2, itemTotal: 2300, comments: "No onions, add bacon" },
          { id: 2, name: "Fries", quantity: 1, itemTotal: 400, comments: null },
        ],
      }],
    },
  },
};

// --- Delivery order (default cents mode) ------------------------------------
console.log("delivery order (cents mode):");
{
  const m = mapZupplerGraphqlOrder(resp);
  const c = m.canonical;

  test("externalId comes from order.uuid", () =>
    assert.equal(m.externalId, "ed6add77-5b2e-40db-afb5-d64143e13abe"));
  test("zupplerRestaurantId is the cart restaurantId as string", () =>
    assert.equal(m.zupplerRestaurantId, "8841"));
  test("orderNumber comes from shortUuid", () =>
    assert.equal(c.orderNumber, "5de2ecfc"));
  test("orderType resolved from service setting id", () =>
    assert.equal(c.orderType, "delivery"));
  test("dueTime normalized to ISO", () =>
    assert.equal(c.dueTime, "2026-08-10T22:30:00.000Z"));
  test("customer name + phone mapped", () => {
    assert.equal(c.customerName, "Jane Doe");
    assert.equal(c.customerPhone, "615-555-0100");
  });
  test("items: qty folded into name, cents->dollars, comments->modifiers", () =>
    assert.deepEqual(c.items, [
      { name: "2x Cheeseburger", price: "$23.00", modifiers: ["No onions, add bacon"] },
      { name: "Fries", price: "$4.00", modifiers: [] },
    ]));
  test("totals converted cents->dollars", () => {
    assert.equal(c.itemsTotal, 27);
    assert.equal(c.tax, 2.57);
    assert.equal(c.serviceFee, 1.5);
    assert.equal(c.customerTotal, 40.06);
  });
  test("delivery fee and tip mapped to their own fields", () => {
    assert.equal(c.deliveryFee, 3.99);
    assert.equal(c.tip, 5);
  });
  test("stored money fields reconcile to customerTotal", () => {
    const sum =
      (c.itemsTotal ?? 0) + (c.tax ?? 0) + (c.serviceFee ?? 0) +
      (c.deliveryFee ?? 0) + (c.tip ?? 0);
    assert.equal(Number(sum.toFixed(2)), c.customerTotal);
  });
  test("paymentType from tender id", () =>
    assert.equal(c.paymentType, "CREDIT"));
  test("notes join cart comments + instructions", () =>
    assert.equal(c.notes, "Gate code 4482 | Leave at door"));
  test("no discount note when discount is 0", () =>
    assert.ok(!/Discount applied/.test(c.notes ?? "")));
}

// --- Pickup order: no service setting, only pickupTime set ------------------
console.log("pickup order (time fallback):");
{
  const pickupResp = {
    order: {
      uuid: "aaaa1111",
      shortUuid: "p1",
      pickupTime: "2026-08-10T23:00:00Z",
      deliveryTime: null,
      dueTime: "2026-08-10T23:00:00Z",
      totals: { subtotal: 1000, tax: 90, service: 0, total: 1090, discount: 0 },
      carts: [{
        restaurantId: 8841,
        settings: {},
        customer: { name: "Bob", phone: "615-555-0200" },
        items: [{ name: "Taco", quantity: 1, itemTotal: 1000, comments: null }],
      }],
    },
  };
  const c = mapZupplerGraphqlOrder(pickupResp).canonical;
  test("orderType falls back to pickup when only pickupTime present", () =>
    assert.equal(c.orderType, "pickup"));
  test("dueTime falls back through deliveryTime/pickupTime", () =>
    assert.equal(c.dueTime, "2026-08-10T23:00:00.000Z"));
}

// --- Discount surfaces in notes ---------------------------------------------
console.log("discount handling:");
{
  const discResp = JSON.parse(JSON.stringify(resp));
  discResp.data.order.totals.discount = 500; // $5.00 in cents
  const c = mapZupplerGraphqlOrder(discResp).canonical;
  test("discount appended to notes", () =>
    assert.ok(/Discount applied: \$5\.00/.test(c.notes ?? "")));
}

// --- Dollars mode: money() must NOT divide by 100 ---------------------------
console.log("dollars mode (ZUPPLER_AMOUNTS=dollars):");
{
  process.env.ZUPPLER_AMOUNTS = "dollars";
  try {
    const c = mapZupplerGraphqlOrder(resp).canonical;
    test("subtotal passed through unchanged in dollars mode", () =>
      assert.equal(c.itemsTotal, 2700));
    test("total passed through unchanged in dollars mode", () =>
      assert.equal(c.customerTotal, 4006));
  } finally {
    delete process.env.ZUPPLER_AMOUNTS; // restore default for any later tests
  }
}

// --- Garbage in: no throw, safe nulls ---------------------------------------
console.log("garbage / malformed input:");
{
  test("garbage object does not throw and yields null ids", () => {
    const g = mapZupplerGraphqlOrder({ hello: "world" });
    assert.equal(g.externalId, null);
    assert.equal(g.zupplerRestaurantId, null);
    assert.equal(g.canonical.orderNumber, "");
    assert.equal(g.canonical.orderType, null);
    assert.deepEqual(g.canonical.items, []);
  });
  test("null input does not throw", () => {
    const g = mapZupplerGraphqlOrder(null);
    assert.equal(g.externalId, null);
    assert.deepEqual(g.canonical.items, []);
  });
}

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
