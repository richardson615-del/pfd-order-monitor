/**
 * The CRM's ezCater tab (2026-10-21): what /api/crm/ezcater hands the CRM
 * for each stored order, the default window, and that the route is on the
 * CRM key and never sends the secret, a phone or the raw payload. Pure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderWindow, toCrmOrder, type EzCaterOrderRowIn } from "../lib/ezcater-crm";

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

const base: EzCaterOrderRowIn = {
  ezcater_order_id: "o1",
  caterer_uuid: "c1",
  restaurant_id: "r1",
  order_number: "ABC-123",
  status: "accepted",
  fulfillment: "delivery",
  event_time: "2026-10-23T17:00:00Z",
  customer_total: "238.64",
  caterer_total_due: 171.02,
  event_count: 1,
  modified_at: null,
  cancelled_at: null,
  first_seen_at: "2026-10-21T23:40:00Z",
  promoted_order_id: null,
  promoted_at: null,
  promote_error: null,
  canonical: {
    customerName: "Jane Doe",
    customerPhone: "6155550100",
    receivedAt: "2026-10-21T23:39:00Z",
    items: [{ name: "2x Brisket Box" }, { name: "Banana Pudding Tray" }],
    notes: "Headcount: 40",
    rawPayload: { secret: "x" },
  },
};

console.log("ezCater orders as the CRM sees them:");
test("waiting order: names, items, notes, money and ezCater's cut", () => {
  const o = toCrmOrder(base);
  assert.equal(o.stage, "waiting");
  assert.equal(o.customerName, "Jane Doe");
  assert.deepEqual(o.items, ["2x Brisket Box", "Banana Pudding Tray"]);
  assert.equal(o.notes, "Headcount: 40");
  assert.equal(o.customerTotal, 238.64);
  assert.equal(o.catererTotalDue, 171.02);
  assert.equal(o.ezcaterFee, 67.62);
  assert.equal(o.placedAt, "2026-10-21T23:39:00Z");
});
test("never carries the phone or the raw payload", () => {
  const json = JSON.stringify(toCrmOrder(base));
  assert.ok(!json.includes("6155550100"));
  assert.ok(!json.includes("rawPayload"));
  assert.ok(!json.includes("secret"));
});
test("stages: in kitchen, failed, cancelled (cancel wins)", () => {
  assert.equal(toCrmOrder({ ...base, promoted_order_id: "x" }).stage, "in_kitchen");
  assert.equal(toCrmOrder({ ...base, promote_error: "boom" }).stage, "promote_failed");
  assert.equal(toCrmOrder({ ...base, status: "cancelled", promoted_order_id: "x" }).stage, "cancelled");
});
test("no catererTotalDue = no fee, never 0", () => {
  assert.equal(toCrmOrder({ ...base, caterer_total_due: null }).ezcaterFee, null);
});
test("a missing canonical is not a crash", () => {
  const o = toCrmOrder({ ...base, canonical: null });
  assert.deepEqual(o.items, []);
  assert.equal(o.customerName, null);
});

console.log("window:");
test("default is 7 days back to 30 ahead", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const w = orderWindow(null, null, now);
  assert.equal(w.from, "2026-10-14T12:00:00.000Z");
  assert.equal(w.to, "2026-11-20T12:00:00.000Z");
});
test("days given are used, junk is ignored", () => {
  assert.deepEqual(orderWindow("2026-10-01", "2026-10-31"), { from: "2026-10-01T00:00:00-06:00", to: "2026-10-31T23:59:59-06:00" });
  const now = new Date("2026-10-21T12:00:00Z");
  assert.equal(orderWindow("'; drop", null, now).from, "2026-10-14T12:00:00.000Z");
});

console.log("route:");
test("on the CRM write key, actor from the header, no secret selected", () => {
  const route = src("app/api/crm/ezcater/route.ts");
  assert.ok(route.includes("authorizeCrmWrite(req)"));
  assert.equal((route.match(/authorizeCrmWrite\(req\)/g) ?? []).length, 2);
  assert.ok(route.includes('req.headers.get("x-crm-actor")'));
  const lib = src("lib/ezcater-crm.ts");
  assert.ok(!/webhook_secret|raw_payload/.test(lib.replace(/\/\*[\s\S]*?\*\//g, "")));
});

console.log(`\n${passed} passed`);
