/**
 * OE2 (prs-crm QUEUE row 313, 2026-11-10): the CRM updates a phone order it
 * already sent - items, tip, payment. The pure rules: which orders may be
 * updated, which get an UPDATED ticket, what the ticket says changed, and
 * that an update job is told apart from a resend.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOrderAction, orderChangeSummary, updatedBanner, updateRefusal, updateReprints } from "../lib/crm-orders";
import { isResendJob, isUpdateJob, resendBy, updateBy } from "../lib/print-policy";

let passed = 0;
const t = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok ${name}`);
};

t("update is an action the CRM may send", () => {
  assert.equal(isOrderAction("update"), true);
});

t("only a phone order that isn't cancelled may be updated; a completed one may (its money still matters)", () => {
  assert.equal(updateRefusal({ source: "phone", status: "new" }), null);
  assert.equal(updateRefusal({ source: "phone", status: "completed" }), null);
  assert.equal(updateRefusal({ source: "zuppler", status: "new" })?.code, "not_phone_order");
  assert.equal(updateRefusal({ source: "ubereats", status: "new" })?.code, "not_phone_order");
  assert.equal(updateRefusal({ source: "phone", status: "cancelled" })?.code, "order_cancelled");
});

t("the kitchen gets an UPDATED ticket only for an order still being worked on today", () => {
  const now = Date.parse("2026-11-10T23:00:00Z"); // 5 pm Chicago
  assert.equal(updateReprints({ status: "accepted", received_at: "2026-11-10T22:30:00Z" }, now), true);
  assert.equal(updateReprints({ status: "new", received_at: "2026-11-10T15:00:00Z" }, now), true);
  assert.equal(updateReprints({ status: "completed", received_at: "2026-11-10T22:30:00Z" }, now), false);
  assert.equal(updateReprints({ status: "accepted", received_at: "2026-11-09T22:30:00Z" }, now), false);
  assert.equal(updateReprints({ status: "accepted", received_at: null }, now), false);
});

t("an update job is its own kind of reprint, never mistaken for a resend", () => {
  const u = updateBy("crm:Pat");
  assert.equal(u, "reprint:update:crm:Pat");
  assert.equal(isUpdateJob(u), true);
  assert.equal(isResendJob(u), false);
  assert.equal(isUpdateJob(resendBy("crm:Pat")), false);
  assert.equal(isUpdateJob(null), false);
});

t("the banner is ASCII for the Epson", () => {
  assert.equal(updatedBanner("P-12"), "*** UPDATED - ORDER #P-12 ***");
  assert.match(updatedBanner("P-12"), /^[\x20-\x7e]+$/);
});

t("what changed: items added and removed, then tip, payment and total", () => {
  const before = {
    items: [{ name: "2x Cheese Pizza", modifiers: [] }, { name: "Garlic Knots", modifiers: ["Ranch"] }],
    tip: 3, payment_type: "PAID - CARD", customer_total: 30.5, notes: null,
  };
  const after = {
    items: [{ name: "3x Cheese Pizza", modifiers: [] }, { name: "Garlic Knots", modifiers: ["Ranch"] }, { name: "Coke", modifiers: [] }],
    tip: 8, payment_type: "CASH - COLLECT $49.00", customer_total: 49, notes: "Ring the bell",
  };
  assert.deepEqual(orderChangeSummary(before, after), [
    "- 2x Cheese Pizza",
    "+ 3x Cheese Pizza",
    "+ Coke",
    "NOTE: Ring the bell",
    "TIP $3.00 -> $8.00",
    "PAYMENT: CASH - COLLECT $49.00",
    "TOTAL $30.50 -> $49.00",
  ]);
  for (const line of orderChangeSummary(before, after)) assert.match(line, /^[\x20-\x7e]+$/);
});

t("nothing changed = nothing listed; a long list is capped with a count", () => {
  const same = { items: [{ name: "Cheese", modifiers: [] }], tip: 2, payment_type: "CASH", customer_total: 12 };
  assert.deepEqual(orderChangeSummary(same, { ...same }), []);
  const many = { items: Array.from({ length: 20 }, (_, i) => ({ name: `Item ${i}`, modifiers: [] })) };
  const out = orderChangeSummary({ items: [] }, many, 5);
  assert.equal(out.length, 5);
  assert.equal(out[4], "...and 16 more change(s)");
});

t("the route answers update and the printer route leads an update with UPDATED and what changed", () => {
  const route = readFileSync(new URL("../app/api/crm/orders/[id]/actions/route.ts", import.meta.url), "utf8");
  assert.match(route, /action === "update"/);
  assert.match(route, /updateRefusal\(order\)/);
  const epson = readFileSync(new URL("../app/api/print/epson/route.ts", import.meta.url), "utf8");
  assert.match(epson, /last_update:raw_payload->last_update/);
  assert.match(epson, /isUpdateJob\(job\.queued_by\)/);
  const contract = readFileSync(new URL("../docs/crm-bridge-contract.md", import.meta.url), "utf8");
  assert.match(contract, /"update"/);
});

console.log(`order update: ${passed} passed`);
