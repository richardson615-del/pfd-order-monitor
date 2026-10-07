/**
 * Y6 (prs-crm QUEUE row 81, Nick 2026-09-28): the ezCater scaffold - provider
 * interface, fake, event decision and the canonical mapping. Pure: no
 * database, no ezCater call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ezCaterAction, ezCaterOrderToCanonical, FakeEzCaterProvider, type EzCaterOrder, type EzCaterOrderEvent } from "../lib/ezcater";
import { moneyVariance } from "../lib/canonical";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const order: EzCaterOrder = {
  orderId: "ezc-7f3a",
  orderNumber: "ZK4-9QX",
  catererLocationId: "loc-willie-maes",
  status: "accepted",
  fulfillment: "delivery",
  eventTime: "2026-10-02T11:30:00-05:00",
  placedAt: "2026-09-29T15:12:00-05:00",
  headcount: 25,
  contact: { name: "Office Manager", phone: "+14175550100" },
  deliveryAddress: { street: "100 Main St", city: "Springfield", state: "MO", zip: "65806", instructions: "Front desk, 2nd floor" },
  items: [
    { name: "Fried Chicken Tray", quantity: 2, total: 180, modifiers: ["Mixed pieces"], specialInstructions: null },
    { name: "Sweet Tea (gallon)", quantity: 1, total: 12, modifiers: [], specialInstructions: "Extra ice" },
  ],
  money: { subtotal: 192, tax: 15.84, deliveryFee: 25, tip: 20, total: 252.84 },
  notes: "Plates and napkins for 25",
};
const event = (type: EzCaterOrderEvent["type"], orderId = order.orderId): EzCaterOrderEvent => ({ type, orderId, catererLocationId: order.catererLocationId, occurredAt: "2026-09-29T15:13:00-05:00" });

async function main() {
  console.log("ezCater scaffold (Y6)");

  await test("accepted and modified upsert the latest order; cancelled - by event or by status - cancels", () => {
    assert.deepEqual(ezCaterAction(event("accepted"), order), { kind: "upsert", order });
    assert.deepEqual(ezCaterAction(event("modified"), order), { kind: "upsert", order });
    assert.deepEqual(ezCaterAction(event("cancelled"), null), { kind: "cancel", orderId: order.orderId });
    assert.deepEqual(ezCaterAction(event("modified"), { ...order, status: "cancelled" }), { kind: "cancel", orderId: order.orderId });
  });

  await test("an order ezCater does not know, or a mismatched fetch, is ignored with the reason - never guessed", () => {
    assert.equal(ezCaterAction(event("accepted"), null).kind, "ignore");
    assert.equal(ezCaterAction(event("accepted", "other"), order).kind, "ignore");
  });

  await test("maps to the canonical order: items as the ticket prints them, address with the driver line, headcount first in notes", () => {
    const c = ezCaterOrderToCanonical(order, { id: "r1", name: "Willie Mae's" });
    assert.equal(c.source, "ezcater");
    assert.equal(c.externalId, "ezc-7f3a");
    assert.equal(c.orderNumber, "ZK4-9QX");
    assert.equal(c.orderType, "delivery");
    assert.equal(c.dueTime, "2026-10-02T11:30:00-05:00");
    assert.equal(c.receivedAt, "2026-09-29T15:12:00-05:00");
    assert.deepEqual(c.items, [
      { name: "2x Fried Chicken Tray", price: "$180.00", modifiers: ["Mixed pieces"] },
      { name: "Sweet Tea (gallon)", price: "$12.00", modifiers: ["Extra ice"] },
    ]);
    assert.equal(c.customerAddress, "100 Main St, Springfield, MO, 65806 | Front desk, 2nd floor");
    assert.equal(c.notes, "Headcount: 25\nPlates and napkins for 25");
    assert.equal(c.paymentType, "ezCater (prepaid)");
  });

  await test("the money reconciles to zero variance, the same check every source passes at ingest", () => {
    const c = ezCaterOrderToCanonical(order, { id: "r1", name: null });
    assert.equal(moneyVariance(c), 0);
  });

  await test("takeout is a pickup with no address", () => {
    const c = ezCaterOrderToCanonical({ ...order, fulfillment: "takeout", deliveryAddress: null }, { id: "r1", name: null });
    assert.equal(c.orderType, "pickup");
    assert.equal(c.customerAddress, null);
  });

  await test("the fake provider delivers events to subscribers and stops on unsubscribe", async () => {
    const p = new FakeEzCaterProvider();
    p.orders.set(order.orderId, order);
    const seen: string[] = [];
    const stop = await p.subscribe(async (e) => {
      const o = await p.fetchOrder(e.orderId);
      seen.push(ezCaterAction(e, o).kind);
    });
    await p.emit(event("accepted"));
    await p.emit(event("cancelled"));
    stop();
    await p.emit(event("modified"));
    assert.deepEqual(seen, ["upsert", "cancel"]);
  });

  await test("nothing here calls ezCater, holds a credential, or ingests", () => {
    const lib = src("lib/ezcater.ts");
    // Code only - the header comment is allowed to talk about what is not built.
    const code = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /fetch\(|https:\/\/|process\.env|ingestOrder\(|supabase/i);
    // Its only import is the canonical TYPE: it cannot reach the database or ingest.
    assert.deepEqual(code.split(/\r?\n/).filter((l) => l.startsWith("import ")), ['import type { CanonicalOrderInput } from "./canonical";']);
    // Migration 050 added 'ezcater' to the canonical source list; promotion lives in lib/ezcater-promote.ts, not here.
    assert.match(src("lib/canonical.ts"), /"ezcater"/);
  });

  console.log(`${passed} passed`);
}

main();
