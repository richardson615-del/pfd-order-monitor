/**
 * ezCater promotion (migration 050): the fee the CRM prices, when an order
 * goes to the kitchen, what the kitchen ticket says, and the guarantees that
 * keep it switched and safe. Pure: no database, no ezCater call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapEzCaterOrder, catererTotalDueOf } from "../lib/ezcater-client";
import { moneyVariance } from "../lib/canonical";
import { buildTicket, toPlainText } from "../lib/ticket";
import { EZCATER_TICKET_BANNER, EZCATER_UPDATED_BANNER, ezCaterFeeOf, ezCaterKitchenOrder, promotionDecision, validLeadHours } from "../lib/ezcater-promote";
import { docsOrder } from "./lib/ezcater-docs-order";

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
const restaurant = { id: "r1", name: "Willie Mae's" };

console.log("ezCater fee (Matt, 2026-09-28: customer total less catererTotalDue):");
test("the docs' example: $238.64 paid, ezCater pays $171.02, so ezCater kept $67.62", () => {
  const o = mapEzCaterOrder(docsOrder);
  assert.equal(o.money.catererTotalDue, 171.02);
  assert.equal(ezCaterFeeOf(o), 67.62);
});
test("catererTotalDue: a dollar number (the docs), a numeric string or a {subunits} money object; anything else is null, never 0", () => {
  assert.equal(catererTotalDueOf(171.02), 171.02);
  assert.equal(catererTotalDueOf("171.02"), 171.02);
  assert.equal(catererTotalDueOf({ subunits: 17102, subunitsV2: "17102" }), 171.02);
  assert.equal(catererTotalDueOf(null), null);
  assert.equal(catererTotalDueOf("n/a"), null);
  const noDue = mapEzCaterOrder({ ...docsOrder, catererCart: { ...docsOrder.catererCart, totals: {} } });
  assert.equal(ezCaterFeeOf(noDue), null); // the CRM then excludes the order `money_null` - loud, not guessed
});

console.log("\nwhen an order goes to the kitchen:");
const now = new Date("2026-10-06T15:00:00Z");
const base = { status: "accepted", promotedOrderId: null, sendToKitchen: true, leadHours: 24, now };
test("inside the lead time: now; outside: wait until hand-off minus the lead", () => {
  assert.deepEqual(promotionDecision({ ...base, eventTime: "2026-10-07T12:00:00Z" }), { kind: "promote" });
  assert.deepEqual(promotionDecision({ ...base, eventTime: "2026-10-09T16:15:00Z" }), { kind: "wait", promoteAt: "2026-10-08T16:15:00.000Z" });
  assert.deepEqual(promotionDecision({ ...base, leadHours: 96, eventTime: "2026-10-09T16:15:00Z" }), { kind: "promote" });
});
test("kitchen switch off, cancelled, or already sent: never", () => {
  assert.equal(promotionDecision({ ...base, sendToKitchen: false, eventTime: "2026-10-06T16:00:00Z" }).kind, "skip");
  assert.equal(promotionDecision({ ...base, status: "cancelled", eventTime: "2026-10-06T16:00:00Z" }).kind, "skip");
  assert.equal(promotionDecision({ ...base, promotedOrderId: "o1", eventTime: "2026-10-06T16:00:00Z" }).kind, "skip");
});
test("no readable hand-off time sends it now rather than holding it forever; a bad lead falls back to 24 h", () => {
  assert.equal(promotionDecision({ ...base, eventTime: null }).kind, "promote");
  assert.deepEqual(promotionDecision({ ...base, leadHours: 0, eventTime: "2026-10-08T15:00:00Z" }), { kind: "wait", promoteAt: "2026-10-07T15:00:00.000Z" });
  assert.equal(validLeadHours(24), 24);
  assert.equal(validLeadHours(0), null);
  assert.equal(validLeadHours(169), null);
  assert.equal(validLeadHours(2.5), null);
});

console.log("\nthe kitchen's order and ticket:");
test("source ezcater, the fee carried, the catering banner first in the notes, money still reconciles", () => {
  const k = ezCaterKitchenOrder(mapEzCaterOrder(docsOrder), restaurant);
  assert.equal(k.source, "ezcater");
  assert.equal(k.ezcaterFee, 67.62);
  assert.equal(k.paymentType, "ezCater (prepaid)");
  assert.ok((k.notes ?? "").startsWith(EZCATER_TICKET_BANNER));
  assert.match(k.notes ?? "", /Headcount: 10/);
  assert.ok(Math.abs(moneyVariance(k) ?? 1) < 0.005);
});
test("a modification after it reached the kitchen leads with UPDATED ORDER", () => {
  const k = ezCaterKitchenOrder(mapEzCaterOrder(docsOrder), restaurant, { updated: true });
  assert.ok((k.notes ?? "").startsWith(EZCATER_UPDATED_BANNER));
});
test("the printed ticket shows the due date (not just a time), the banner and the headcount", () => {
  const k = ezCaterKitchenOrder(mapEzCaterOrder(docsOrder), restaurant);
  const text = toPlainText(buildTicket({ order_number: k.orderNumber, source: "ezcater", ticket_restaurant_name: "Willie Mae's", order_type: "delivery", due_time: k.dueTime, received_at: "2025-03-26T15:00:00Z", customer_name: k.customerName, items: k.items, items_total: k.itemsTotal, tax: k.tax, delivery_fee: k.deliveryFee, customer_total: k.customerTotal, payment_type: k.paymentType, notes: k.notes }));
  assert.match(text, /DUE\s+Thu, Mar 27/);
  assert.match(text, /ezCATER CATERING/);
  assert.match(text, /Headcount: 10/);
});

console.log("\nguarantees:");
test("migration 050: 'ezcater' is a source, the kitchen switch defaults off and needs the location on, lead 1-168 h", () => {
  const m = src("db/migrations/050_ezcater_promotion.sql");
  assert.match(m, /check \(source in \('email', 'zuppler', 'test', 'phone', 'ezcater'\)\)/);
  assert.match(m, /send_to_kitchen boolean not null default false/);
  assert.match(m, /check \(not send_to_kitchen or active\)/);
  assert.match(m, /check \(kitchen_lead_hours between 1 and 168\)/);
});
test("ezcater_fee reaches the CRM's accounting feed with the restaurant's CRM account", () => {
  const route = src("app/api/crm/accounting/orders/route.ts");
  assert.match(route, /ezcater_fee: num\(o\.ezcater_fee\)/);
  assert.match(route, /crm_restaurant_id: o\.restaurants\?\.crm_restaurant_id/);
  assert.match(route, /restaurants\(name, zuppler_restaurant_id, crm_restaurant_id\)/);
});
test("ezcater_fee is written only for ezCater orders and is not part of money_variance", () => {
  assert.match(src("lib/canonical.ts"), /input\.source === "ezcater" \? \{ ezcater_fee: input\.ezcaterFee/);
  const mv = src("lib/canonical.ts").split("export function moneyVariance")[1].split("\n}\n")[0];
  assert.doesNotMatch(mv, /ezcater/i);
});
test("the kitchen sync never throws into the webhook, and the monitor sweep cannot stop the health checks", () => {
  const promote = src("lib/ezcater-promote.ts");
  assert.match(promote, /catch \(err\) \{\s*const detail/);
  const monitor = src("app/api/monitor/check/route.ts");
  assert.match(monitor, /try \{\s*ezcater = await promoteDueEzCaterOrders\(\);\s*\} catch/);
});
test("a cancellation after promotion pulls queued tickets and never clears printed_at", () => {
  const promote = src("lib/ezcater-promote.ts").split("async function cancelInKitchen")[1];
  assert.match(promote, /from\("print_jobs"\)[\s\S]*\.in\("status", \["queued", "claimed"\]\)/);
  assert.doesNotMatch(promote, /printed_at: null/);
});

console.log(`${passed} passed`);
