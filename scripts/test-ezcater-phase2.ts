/**
 * ezCater Phase 2 (Matt, 2026-09-28): signature, the real order mapping (on
 * ezCater's own documented example), notification rules, the seed plan, and
 * the guarantees that printing stays off. Pure: no database, no ezCater call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { signEzCaterBody, verifyEzCaterSignature } from "../lib/ezcater-signature";
import { mapEzCaterOrder, ORDER_QUERY, CATERERS_QUERY, CREATE_SUBSCRIPTION_MUTATION } from "../lib/ezcater-client";
import { readNotification, ezCaterTimeToIso } from "../lib/ezcater-ingest";
import { EZCATER_SEED, EZCATER_SUBSCRIBED_EVENTS, planSeed } from "../lib/ezcater-admin";
import { ezCaterOrderToCanonical } from "../lib/ezcater";
import { moneyVariance } from "../lib/canonical";

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

// ---- signature -------------------------------------------------------------------

console.log("ezCater signature (X-Ezcater-Signature):");
const secret = "be6efd0f8e88fec0d51364559ca9a258e70031f7f38448ea2e9705928a929a8d"; // the docs' example secret
const body = JSON.stringify({ id: "n1", parent_type: "Caterer", parent_id: "c1", entity_type: "Order", entity_id: "o1", key: "accepted", payload: null });

test("the docs' recipe: hex HMAC-SHA256 of '<timestamp>.<body>' with the webhook secret", () => {
  const ts = 1759075200;
  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const r = verifyEzCaterSignature(`${ts}.${expected}`, body, secret, new Date(ts * 1000 + 5000));
  assert.deepEqual(r, { ok: true, timestamp: ts, ageSeconds: 5 });
});

test("a changed body, a wrong secret, or a missing/malformed header is refused", () => {
  const h = signEzCaterBody(body, secret, 1759075200);
  assert.equal(verifyEzCaterSignature(h, body + " ", secret).ok, false);
  assert.equal(verifyEzCaterSignature(h, body, "other").ok, false);
  assert.deepEqual(verifyEzCaterSignature(null, body, secret), { ok: false, reason: "no_header" });
  assert.deepEqual(verifyEzCaterSignature("nodot", body, secret), { ok: false, reason: "malformed_header" });
  assert.deepEqual(verifyEzCaterSignature("abc.def", body, secret), { ok: false, reason: "malformed_header" });
  assert.deepEqual(verifyEzCaterSignature(h, body, null), { ok: false, reason: "no_secret" });
});

test("the part before the first period is the timestamp, the rest is the signature (uppercase hex accepted)", () => {
  const sig = createHmac("sha256", secret).update(`1759075200.${body}`).digest("hex");
  assert.equal(verifyEzCaterSignature(`1759075200.${sig.toUpperCase()}`, body, secret).ok, true);
  assert.equal(verifyEzCaterSignature(`1759075201.${sig}`, body, secret).ok, false);
});

test("no age limit is enforced (none is documented): an old but valid signature passes and reports its age", () => {
  const r = verifyEzCaterSignature(signEzCaterBody(body, secret, 1700000000), body, secret, new Date(1759075200 * 1000));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.ageSeconds, 59075200);
});

// ---- the order, from ezCater's documented example -----------------------------

console.log("\nezCater order -> EzCaterOrder (https://api.ezcater.io/order-details example):");
const money = (c: number) => ({ currency: "USD", subunits: c, subunitsV2: String(c) });
const docsOrder = {
  deliveryId: "3593ce70-7227-4fd4-8a78-9591083d0674",
  uuid: "your-ezcater-order-id",
  caterer: { uuid: "ezcater-caterer-id", name: "My Caterer Name", storeNumber: "00001", live: true, address: { city: "Boston" } },
  catererCart: {
    feesAndDiscounts: [
      { cost: money(2999), name: "Delivery Fee" },
      { cost: money(-1199), name: "Preferred Caterer Program" },
      { cost: money(-1199), name: "Rewards Promo" },
    ],
    orderItems: [
      { customizations: [{ customizationTypeName: "Cheese Addon", name: "Parmigiano Reggiano", quantity: 10 }], labelFor: null, menuItemSizeName: '12" Pizza', name: "Margherita Pizza", noteToCaterer: '12" thin crust Margherita Pizza', quantity: 10, specialInstructions: "Please be careful not to burn crust", totalInSubunits: money(16750), uuid: "i1" },
      { customizations: [{ customizationTypeName: "Soda", name: "Select Soda", quantity: 10 }], labelFor: null, menuItemSizeName: "2ltr Soda", name: "Assorted Sodas", noteToCaterer: "2ltr brand name sodas from fridge", quantity: 10, specialInstructions: "Please bring cold soda if possible", totalInSubunits: money(2750), uuid: "i2" },
    ],
    tableware: { specialInstructions: null, tablewareChoices: [{ isIncluded: true, itemCount: 10, name: "Napkins" }, { isIncluded: true, itemCount: 10, name: "Plates" }, { isIncluded: false, itemCount: 10, name: "Forks" }] },
    totals: { catererTotalDue: 171.02 },
  },
  event: {
    address: { city: "Boston", deliveryInstructions: "Ask for Jane at front desk", name: "My Office", state: "MA", street: "2345 Business Boulevard", street2: null, zip: "23456" },
    catererHandoffFoodTime: "2025-03-27T16:15:00Z",
    contact: { name: "Jane Doe", phone: "5555555555" },
    customerProvidedName: "Team building event",
    headcount: 10,
    orderType: "DELIVERY",
    thirdPartyDeliveryPartner: null,
    timestamp: "2025-03-27T16:30:00Z",
  },
  lifecycle: { orderIsCurrently: "accepted" },
  orderCustomer: { fullName: "Jane Doe" },
  orderNumber: "O1O1O1",
  totals: { customerTotalDue: money(23864), salesTax: money(1365), subTotal: money(19500), tip: money(0) },
};

test("money in dollars from subunits; the customer's delivery fee only (not ezCater's deductions); total reconciles", () => {
  const o = mapEzCaterOrder(docsOrder);
  assert.deepEqual(o.money, { subtotal: 195, tax: 13.65, deliveryFee: 29.99, tip: 0, total: 238.64 });
  const c = ezCaterOrderToCanonical(o, { id: "r1", name: "Willie Mae's" });
  assert.ok(Math.abs(moneyVariance(c) ?? 1) < 0.005);
});

test("identity, the hand-off time as the deadline, delivery, contact, address, headcount", () => {
  const o = mapEzCaterOrder(docsOrder);
  assert.equal(o.orderId, "your-ezcater-order-id");
  assert.equal(o.orderNumber, "O1O1O1");
  assert.equal(o.catererLocationId, "ezcater-caterer-id");
  assert.equal(o.status, "accepted");
  assert.equal(o.fulfillment, "delivery");
  assert.equal(o.eventTime, "2025-03-27T16:15:00Z");
  assert.deepEqual(o.contact, { name: "Jane Doe", phone: "5555555555" });
  assert.deepEqual(o.deliveryAddress, { street: "2345 Business Boulevard", city: "Boston", state: "MA", zip: "23456", instructions: "Ask for Jane at front desk" });
  assert.equal(o.headcount, 10);
});

test("items carry size, customizations, the note to the caterer and special instructions; tableware (included only) goes in the notes", () => {
  const o = mapEzCaterOrder(docsOrder);
  assert.equal(o.items[0].name, 'Margherita Pizza (12" Pizza)');
  assert.equal(o.items[0].quantity, 10);
  assert.equal(o.items[0].total, 167.5);
  assert.deepEqual(o.items[0].modifiers, ["Cheese Addon: Parmigiano Reggiano", '12" thin crust Margherita Pizza']);
  assert.equal(o.items[0].specialInstructions, "Please be careful not to burn crust");
  assert.match(o.notes ?? "", /Tableware: Napkins x10, Plates x10/);
  assert.doesNotMatch(o.notes ?? "", /Forks/);
  assert.match(o.notes ?? "", /Event: Team building event/);
});

test("takeout and cancelled read through; a missing id, number, caterer or total is refused, never guessed", () => {
  assert.equal(mapEzCaterOrder({ ...docsOrder, event: { ...docsOrder.event, orderType: "TAKEOUT" } }).fulfillment, "takeout");
  assert.equal(mapEzCaterOrder({ ...docsOrder, lifecycle: { orderIsCurrently: "cancelled" } }).status, "cancelled");
  assert.throws(() => mapEzCaterOrder({ ...docsOrder, totals: { ...docsOrder.totals, customerTotalDue: null } }), /customerTotalDue/);
  assert.throws(() => mapEzCaterOrder({ ...docsOrder, uuid: null }), /uuid/);
  assert.throws(() => mapEzCaterOrder({ ...docsOrder, caterer: null }), /caterer\.uuid/);
});

test("the queries are the documented ones, named, with the raw-token Authorization header", () => {
  assert.match(ORDER_QUERY, /^query Order\(\$orderId: ID!\)/);
  assert.match(ORDER_QUERY, /catererHandoffFoodTime/);
  assert.match(CATERERS_QUERY, /^query Caterers/);
  assert.match(CREATE_SUBSCRIPTION_MUTATION, /^mutation CreateSubscription/);
  const client = src("lib/ezcater-client.ts");
  assert.match(client, /Authorization: token,/);
  assert.doesNotMatch(client, /Authorization:\s*`Bearer/);
  assert.match(client, /"Apollographql-client-name"/);
});

// ---- notifications -----------------------------------------------------------------

console.log("\nnotifications:");
test("accepted and cancelled Order events are acted on; anything else is ignored with the reason", () => {
  const n = { id: "n", parent_type: "Caterer", parent_id: "c1", entity_type: "Order", entity_id: "o1", key: "accepted", occurred_at: "2025-04-15 23:48:21 UTC" };
  const r = readNotification(n);
  assert.ok("event" in r);
  assert.deepEqual("event" in r && r.event, { type: "accepted", orderId: "o1", catererLocationId: "c1", occurredAt: "2025-04-15T23:48:21.000Z" });
  assert.ok("event" in readNotification({ ...n, key: "cancelled" }));
  assert.ok("ignore" in readNotification({ ...n, key: "submitted" }));
  assert.ok("ignore" in readNotification({ ...n, key: "uncancelled" }));
  assert.ok("ignore" in readNotification({ ...n, entity_type: "Menu" }));
  assert.ok("ignore" in readNotification({ ...n, entity_id: undefined }));
  assert.equal(ezCaterTimeToIso("nonsense"), null);
});

test("there is no 'modified' event to subscribe to: accepted (which re-fires on a modification) + cancelled", () => {
  assert.deepEqual([...EZCATER_SUBSCRIBED_EVENTS], ["accepted", "cancelled"]);
});

// ---- the seed ----------------------------------------------------------------------

console.log("\nthe six locations (Matt, 2026-09-28):");
test("six seed rows, by uuid prefix", () => {
  assert.deepEqual(EZCATER_SEED.map((s) => s.prefix), ["7f2a4942", "0996f96f", "7a0e1f7d", "f72aee20", "e818e720", "43a61b77"]);
});

test("a seed links only on exactly one caterer and exactly one restaurant, never overwrites a link, and never activates", () => {
  const caterers = [
    { caterer_uuid: "7f2a4942-aaaa", name: "Willie Mae's BBQ", restaurant_id: null },
    { caterer_uuid: "0996f96f-bbbb", name: "Larry's", restaurant_id: "r-other" },
    { caterer_uuid: "7a0e1f7d-cccc", name: "Sylfoni's", restaurant_id: null },
    { caterer_uuid: "7a0e1f7d-dddd", name: "Sylfoni's 2", restaurant_id: null },
    { caterer_uuid: "e818e720-eeee", name: "All Seasons Sports Grill", restaurant_id: null },
    { caterer_uuid: "43a61b77-ffff", name: "Torino's", restaurant_id: null },
  ];
  const restaurants = [
    { id: "r-wm", name: "Willie Mae’s BBQ" },
    { id: "r-larry", name: "Larry's Burgers" },
    { id: "r-t1", name: "Torino's Pizza" },
    { id: "r-t2", name: "Torino's Catering" },
  ];
  const plan = Object.fromEntries(planSeed(caterers, restaurants).map((p) => [p.label, p]));
  assert.equal(plan["Willie Mae's"].result, "linked");
  assert.equal(plan["Willie Mae's"].restaurantId, "r-wm");
  assert.equal(plan["Larry's"].result, "linked_elsewhere");
  assert.equal(plan["Sylfoni's"].result, "caterer_ambiguous");
  assert.equal(plan["El Molcajete"].result, "caterer_missing");
  assert.equal(plan["All Seasons Sports Grill"].result, "restaurant_missing");
  assert.equal(plan["Torino's"].result, "restaurant_ambiguous");
  assert.doesNotMatch(src("lib/ezcater-admin.ts").split("export async function applySeed")[1].split("export class")[0], /active/);
});

// ---- printing stays off --------------------------------------------------------------

console.log("\nprinting is OFF while ingestion is proven (Matt, 2026-09-28):");
test("the ezCater ingest never writes `orders` and never calls ingestOrder, print jobs or push", () => {
  const ingest = src("lib/ezcater-ingest.ts");
  assert.doesNotMatch(ingest, /from\("orders"\)/);
  assert.doesNotMatch(ingest, /ingestOrder|print_jobs|notifyRestaurant|deliverToApp/);
  assert.match(ingest, /from\("ezcater_orders"\)/);
});

test("an inactive or unlinked location is recorded and not ingested; active needs a restaurant (DB check)", () => {
  const ingest = src("lib/ezcater-ingest.ts");
  assert.match(ingest, /if \(!location\.active\) return \{ status: "inactive"/);
  assert.match(ingest, /if \(!location\.restaurant_id\) return \{ status: "unmapped"/);
  assert.match(src("db/migrations/045_ezcater.sql"), /check \(not active or restaurant_id is not null\)/);
});

test("the webhook secret never leaves the server: the state read selects no secret, and the table is revoked from clients", () => {
  const admin = src("lib/ezcater-admin.ts");
  const state = admin.split("export async function getEzCaterState")[1];
  assert.doesNotMatch(state, /webhook_secret/);
  assert.match(src("db/migrations/045_ezcater.sql"), /revoke all on ezcater_subscriber from anon, authenticated/);
});

test("Zuppler's webhook health and backfill read only Zuppler's receipts", () => {
  const health = src("lib/health.ts").split('const [lastReceiptRes, lastAcceptedRes, recentRes]')[1].split("]);")[0];
  assert.equal((health.match(/\.eq\("source", "zuppler"\)/g) ?? []).length, 3);
  assert.match(src("scripts/backfill-zuppler-orders.ts"), /\.eq\("source", "zuppler"\)\s*\n\s*\.eq\("status", "unmapped"\)/);
});

console.log(`\n${passed} ezCater Phase 2 assertions passed.`);
