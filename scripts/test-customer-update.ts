/**
 * ED3 (2026-11-28, prs-crm brief docs/briefs/2026-11-28-edit-customer-
 * details-on-orders.md): the CRM changes an order's customer details and the
 * restaurant sees it. The pure rules - what the body may carry, which
 * columns move, what the UPDATED ticket says, when the tablet's yellow
 * banner shows and clears, that a later Zuppler revision does not put the
 * old details back - plus the wiring a refactor could quietly drop.
 * Fake data only.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isOrderAction, ORDER_ACTIONS } from "../lib/crm-orders";
import {
  customerChangeSummary,
  customerColumns,
  joinAddress,
  keepCrmCustomerEdits,
  parseCustomerUpdate,
  splitAddress,
  type CustomerUpdate,
} from "../lib/customer-update";
import { customerChangeBanner } from "../lib/customer-change-banner";
import { parseOrderPatch } from "../lib/ready-timer";

let passed = 0;
const t = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok ${name}`);
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const parsed = (body: unknown): CustomerUpdate => {
  const r = parseCustomerUpdate(body);
  if ("error" in r) throw new Error(`expected ok, got ${r.code}`);
  return r.update;
};

console.log("contract body:");

t("update_customer is an action the CRM may send; the old ones are all still there", () => {
  assert.equal(isOrderAction("update_customer"), true);
  for (const a of ["reprint", "resend_app", "resend", "cancel", "picked_up", "reopen", "set_ready", "update", "send_to_kitchen", "driver"]) {
    assert.ok(ORDER_ACTIONS.includes(a as any), a);
  }
});

t("changed_fields is required and may only name the four fields", () => {
  assert.equal((parseCustomerUpdate({}) as any).code, "changed_fields_required");
  assert.equal((parseCustomerUpdate({ changed_fields: [] }) as any).code, "changed_fields_required");
  assert.equal((parseCustomerUpdate({ changed_fields: ["tip"], tip: 9 }) as any).code, "invalid_changed_fields");
});

t("only the listed fields are taken, even when all four are sent", () => {
  const u = parsed({
    changed_fields: ["customer_phone"],
    customer_name: "Pat Example",
    customer_phone: "(615) 555-0100",
    delivery_address: "1 Test Rd, Springfield, TN",
    delivery_notes: "Gate 1234",
  });
  assert.deepEqual(u.changed, ["customer_phone"]);
  assert.deepEqual(u.values, { customer_phone: "(615) 555-0100" });
});

t("a listed name, phone or address needs a value; directions may be cleared", () => {
  assert.equal((parseCustomerUpdate({ changed_fields: ["customer_name"], customer_name: "  " }) as any).code, "invalid_field");
  assert.equal((parseCustomerUpdate({ changed_fields: ["delivery_address"] }) as any).code, "invalid_field");
  assert.equal((parseCustomerUpdate({ changed_fields: ["customer_phone"], customer_phone: 6155550100 }) as any).code, "invalid_field");
  assert.deepEqual(parsed({ changed_fields: ["delivery_notes"], delivery_notes: null }).values, { delivery_notes: null });
  assert.deepEqual(parsed({ changed_fields: ["delivery_notes"], delivery_notes: "" }).values, { delivery_notes: null });
});

t("an address may not carry the ' | ' that separates it from the directions; too long is refused", () => {
  assert.equal((parseCustomerUpdate({ changed_fields: ["delivery_address"], delivery_address: "1 Test Rd | side door" }) as any).code, "invalid_field");
  assert.equal((parseCustomerUpdate({ changed_fields: ["customer_name"], customer_name: "x".repeat(121) }) as any).code, "invalid_field");
});

t("a card number typed into any field is refused, never stored", () => {
  const r = parseCustomerUpdate({ changed_fields: ["delivery_notes"], delivery_notes: "card 4111 1111 1111 1111" });
  assert.equal((r as any).code, "card_number_rejected");
});

console.log("\ncolumns:");

t("directions are the second half of customer_address; changing one half keeps the other", () => {
  assert.deepEqual(splitAddress("1 Old Rd, Springfield | Gate 1234"), { street: "1 Old Rd, Springfield", notes: "Gate 1234" });
  assert.deepEqual(splitAddress("1 Old Rd"), { street: "1 Old Rd", notes: null });
  assert.deepEqual(splitAddress(null), { street: null, notes: null });
  assert.equal(joinAddress("1 Old Rd", null), "1 Old Rd");
  assert.equal(joinAddress(null, null), null);

  const row = { customer_name: "Pat", customer_phone: "615-555-0100", customer_address: "1 Old Rd | Gate 1234" };
  const addr = customerColumns(row, parsed({ changed_fields: ["delivery_address"], delivery_address: "2 New St" }));
  assert.deepEqual(addr, { columns: { customer_address: "2 New St | Gate 1234" }, changed: ["delivery_address"] });
  const notes = customerColumns(row, parsed({ changed_fields: ["delivery_notes"], delivery_notes: "Back door" }));
  assert.deepEqual(notes, { columns: { customer_address: "1 Old Rd | Back door" }, changed: ["delivery_notes"] });
  const cleared = customerColumns(row, parsed({ changed_fields: ["delivery_notes"], delivery_notes: null }));
  assert.deepEqual(cleared, { columns: { customer_address: "1 Old Rd" }, changed: ["delivery_notes"] });
});

t("a field sent with the value it already has is not a change (the kitchen is not told about nothing)", () => {
  const row = { customer_name: "Pat", customer_phone: "615-555-0100", customer_address: "1 Old Rd | Gate 1234" };
  const same = customerColumns(row, parsed({ changed_fields: ["customer_name", "delivery_notes"], customer_name: "Pat", delivery_notes: "Gate 1234" }));
  assert.deepEqual(same, { columns: {}, changed: [] });
  const both = customerColumns(row, parsed({ changed_fields: ["customer_name", "customer_phone"], customer_name: "Sam", customer_phone: "615-555-0199" }));
  assert.deepEqual(both.changed, ["customer_name", "customer_phone"]);
  assert.deepEqual(both.columns, { customer_name: "Sam", customer_phone: "615-555-0199" });
});

t("no money column is ever in what an update writes", () => {
  const row = { customer_name: "Pat", customer_phone: "1", customer_address: "1 Old Rd" };
  const all = customerColumns(row, parsed({ changed_fields: ["customer_name", "customer_phone", "delivery_address", "delivery_notes"], customer_name: "S", customer_phone: "2", delivery_address: "2 New St", delivery_notes: "x" }));
  assert.deepEqual(Object.keys(all.columns).sort(), ["customer_address", "customer_name", "customer_phone"]);
});

t("the UPDATED ticket leads with CUSTOMER DETAILS CHANGED and lists each change in ASCII", () => {
  const u = parsed({ changed_fields: ["delivery_address", "delivery_notes"], delivery_address: "2 New St, Springfield, TN", delivery_notes: null });
  const lines = customerChangeSummary(u, ["delivery_address", "delivery_notes"]);
  assert.deepEqual(lines, ["CUSTOMER DETAILS CHANGED", "ADDRESS: 2 New St, Springfield, TN", "DIRECTIONS: (removed)"]);
  for (const l of lines) assert.match(l, /^[\x20-\x7e]+$/);
});

console.log("\ntablet banner:");

const changed = { status: "opened", customer_changed_at: "2026-11-28T23:40:00Z", customer_changed_fields: ["delivery_address", "delivery_notes"], customer_change_seen_at: null };

t("shows after a change, with what changed in plain words", () => {
  assert.deepEqual(customerChangeBanner(changed), { at: "2026-11-28T23:40:00Z", fields: ["address", "directions"] });
});

t("clears once somebody taps it, and comes back for a newer change", () => {
  assert.equal(customerChangeBanner({ ...changed, customer_change_seen_at: "2026-11-28T23:41:00Z" }), null);
  assert.ok(customerChangeBanner({ ...changed, customer_change_seen_at: "2026-11-28T23:39:00Z" }));
});

t("an old row, a row from before migration 069, or a settled order never shows one", () => {
  assert.equal(customerChangeBanner({ status: "opened" }), null);
  assert.equal(customerChangeBanner({ status: "opened", customer_changed_at: null }), null);
  assert.equal(customerChangeBanner({ ...changed, status: "completed" }), null);
  assert.equal(customerChangeBanner({ ...changed, status: "cancelled" }), null);
  assert.equal(customerChangeBanner({ ...changed, customer_changed_at: "not a date" }), null);
});

t("an unknown field name from a newer CRM is dropped, not shown raw", () => {
  assert.deepEqual(customerChangeBanner({ ...changed, customer_changed_fields: ["customer_phone", "something_new"] })?.fields, ["phone"]);
});

t("the tap is its own PATCH { customer_seen: true }, never mixed with another action", () => {
  assert.deepEqual(parseOrderPatch({ customer_seen: true }), { ok: true, patch: { kind: "customer_seen" } });
  assert.equal((parseOrderPatch({ customer_seen: true, ready: true }) as any).code, "invalid_body");
  assert.equal((parseOrderPatch({ customer_seen: true, status: "completed" }) as any).code, "invalid_body");
  // The old actions are unchanged.
  assert.deepEqual(parseOrderPatch({ ready: true }), { ok: true, patch: { kind: "ready" } });
  assert.deepEqual(parseOrderPatch({ status: "completed" }), { ok: true, patch: { kind: "status", status: "completed" } });
});

console.log("\nzuppler revisions:");

t("after dispatch corrected the details, a Zuppler revision's name, phone and address are dropped; its money still lands", () => {
  const diff = { customer_address: "1 Old Rd", customer_phone: "old", tip: 11.37 };
  assert.deepEqual(keepCrmCustomerEdits({ customer_changed_at: "2026-11-28T23:40:00Z" }, diff), { tip: 11.37 });
  assert.equal(keepCrmCustomerEdits({ customer_changed_at: "2026-11-28T23:40:00Z" }, { customer_name: "Old" }), null);
  assert.deepEqual(keepCrmCustomerEdits({ customer_changed_at: null }, diff), diff);
  assert.deepEqual(keepCrmCustomerEdits({}, diff), diff);
});

console.log("\nwiring:");

t("the route answers update_customer through the parser and the server write", () => {
  const route = read("app/api/crm/orders/[id]/actions/route.ts");
  assert.match(route, /action === "update_customer"/);
  assert.match(route, /parseCustomerUpdate\(body\)/);
  assert.match(route, /updateCustomerForCrm\(/);
});

t("the server write stamps the banner, tells the kitchen only via updateReprints, and logs no values", () => {
  const src = read("lib/customer-update-server.ts");
  assert.match(src, /customer_changed_at: at/);
  assert.match(src, /customer_change_seen_at: null/);
  assert.match(src, /updateReprints\(full/);
  assert.match(src, /resendOrder\(after, opts\.actor, \{ kind: "update", summary \}\)/);
  assert.match(src, /last_update: \{/);
  const log = src.match(/console\.log\([^\n]*\n?/g) ?? [];
  assert.equal(log.length, 1);
  assert.doesNotMatch(log[0], /customer_phone|values|columns/);
});

t("ingest runs a Zuppler revision through keepCrmCustomerEdits", () => {
  assert.match(read("lib/canonical.ts"), /keepCrmCustomerEdits\(edited \?\? \{\}, diff\)/);
});

t("the tablet card and the ticket show the banner; the tablet route stamps the tap", () => {
  assert.match(read("components/OrderCard.tsx"), /<CustomerChangedBanner order=\{order\}/);
  assert.match(read("components/OrderViewer.tsx"), /<CustomerChangedBanner order=\{order\}/);
  assert.match(read("components/OrderDashboard.tsx"), /onCustomerSeen=\{customerSeen\}/);
  assert.match(read("components/CustomerChangedBanner.tsx"), /Customer details changed/);
  assert.match(read("app/api/orders/[id]/route.ts"), /customer_change_seen_at: now/);
  // The banner module is imported by the browser: it must not pull server code in.
  assert.doesNotMatch(read("lib/customer-change-banner.ts"), /^import /m);
});

t("migration 069 adds the three columns, additive and nullable", () => {
  const p = "db/migrations/069_customer_details_update.sql";
  assert.ok(existsSync(new URL(`../${p}`, import.meta.url)));
  const sql = read(p);
  for (const c of ["customer_changed_at timestamptz", "customer_changed_fields text[]", "customer_change_seen_at timestamptz"]) {
    assert.match(sql, new RegExp(`add column if not exists ${c.replace(/[[\]]/g, "\\$&")}`));
  }
  assert.doesNotMatch(sql, /not null|drop /i);
  assert.match(read("lib/expected-migrations.ts"), /069_customer_details_update\.sql/);
});

t("the contract documents update_customer and its version moved", () => {
  const contract = read("docs/crm-bridge-contract.md");
  assert.match(contract, /\*\*`update_customer`\*\*/);
  assert.match(contract, /Contract version: \*\*2026-11-28\.1\*\*/);
});

console.log(`customer update: ${passed} passed`);
