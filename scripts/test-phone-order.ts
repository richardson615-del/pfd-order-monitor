/**
 * Phone orders taken in the CRM (Workstream O1, Nick 2026-09-18).
 *
 * What POST /api/crm/orders accepts, how a phone order becomes the
 * canonical order every other source produces, what the ticket says about
 * the money ("PAID - CARD ****1234" / "CASH DUE $42.10", never Zuppler),
 * and how a retry is told from a different order under the same id. The
 * route itself is read as source to pin the rules that need a database:
 * it goes through ingestOrder(), so paper / tablet / email are decided by
 * orderDestinations() and nothing here re-implements delivery.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PHONE_ORDER_MAX_TOTAL,
  defaultOrderNumber,
  looksLikeCardNumber,
  parsePhoneOrder,
  phoneOrderFingerprint,
  phoneOrderToCanonical,
  storedFingerprint,
  tenderLine,
  type PhoneOrder,
} from "../lib/phone-order";
import { moneyVariance } from "../lib/canonical";
import { TENDER_LINE_RE, buildTicket, toEposPrintXml, toPlainText } from "../lib/ticket";

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
const CRM_ACCOUNT = "45bef1a1-7c3d-4e2f-8a1b-9c0d1e2f3a4b";
const PHONE_ORDER_ID = "7d1f2c3a-9b8e-4c6d-a5f4-3e2d1c0b9a87";

/** A valid body, as the CRM's order builder would send it. */
const body = (over: Record<string, unknown> = {}) => ({
  restaurant_id: CRM_ACCOUNT,
  source: "phone",
  external_id: PHONE_ORDER_ID,
  order_type: "delivery",
  due_time: null,
  customer: { name: "Marcus Bell", phone: "(615) 555-0142", address: "5432 Highway 76 East, Springfield, TN 37172", address2: "Apt 4", notes: "Gate code 4482" },
  items: [
    { name: "Shrimp Po'Boy", price: 14, qty: 2, modifiers: [{ name: "Dressed", price: 0 }, { name: "Extra shrimp", price: 3 }], notes: "no pickles" },
    { name: "Gumbo (cup)", price: 6, qty: 1, modifiers: [] },
  ],
  money: { subtotal: 40, tax: 3.9, delivery_fee: 4.99, service_fee: 0, tip: 8, discount: 0, surcharge: 1.2, total: 58.09 },
  payment: { type: "card", status: "paid", last4: "8598" },
  notes: "Ring the bell",
  actor: "dispatcher@pfdworks.com",
  ...over,
});

const parse = (over: Record<string, unknown> = {}) => parsePhoneOrder(body(over));
const ok = (over: Record<string, unknown> = {}): PhoneOrder => {
  const r = parse(over);
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.error}`);
  return r.order;
};
const bad = (over: Record<string, unknown>, code: string) => {
  const r = parse(over);
  assert.ok(!r.ok, `expected ${code}, got a valid order`);
  if (!r.ok) assert.equal(r.code, code, r.error);
};

console.log("the body:");

test("a well-formed phone order parses, with every field where the mapper expects it", () => {
  const o = ok();
  assert.equal(o.restaurant_ref, CRM_ACCOUNT);
  assert.equal(o.external_id, PHONE_ORDER_ID);
  assert.equal(o.order_type, "delivery");
  assert.equal(o.due_time, null, "ASAP");
  assert.equal(o.customer.name, "Marcus Bell");
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items[0].modifiers, [{ name: "Dressed", price: 0 }, { name: "Extra shrimp", price: 3 }]);
  assert.equal(o.money.total, 58.09);
  assert.deepEqual(o.payment, { type: "card", status: "paid", last4: "8598" });
  assert.equal(o.actor, "dispatcher@pfdworks.com");
});

test("either id is accepted: restaurant_id or crm_restaurant_id, resolved by the route", () => {
  assert.equal(ok({ restaurant_id: undefined, crm_restaurant_id: "acct_123" }).restaurant_ref, "acct_123");
  bad({ restaurant_id: undefined }, "restaurant_required");
});

test("source must be 'phone' - this route is not a second Zuppler webhook", () => {
  bad({ source: "zuppler" }, "invalid_source");
  bad({ source: undefined }, "invalid_source");
});

test("external_id is the idempotency key and is required", () => {
  bad({ external_id: undefined }, "external_id_required");
  bad({ external_id: "has spaces" }, "external_id_required");
  bad({ external_id: "x".repeat(129) }, "external_id_required");
});

test("order_number defaults to P- and the id's tail; a CRM-chosen one must fit a ticket", () => {
  assert.equal(ok().order_number, "P-0B9A87");
  assert.equal(defaultOrderNumber(PHONE_ORDER_ID), "P-0B9A87");
  assert.equal(defaultOrderNumber("abc"), "P-ABC");
  assert.equal(ok({ order_number: "PH-1201" }).order_number, "PH-1201");
  bad({ order_number: "#12 01" }, "invalid_order_number");
});

test("order_type is delivery or pickup, and a delivery needs an address", () => {
  bad({ order_type: "dine_in" }, "invalid_order_type");
  bad({ customer: { name: "Marcus Bell" } }, "address_required");
  assert.equal(ok({ order_type: "pickup", customer: { name: "Marcus Bell" } }).customer.address, null);
});

test("due_time is an ISO instant or null; anything else is refused, not guessed", () => {
  assert.equal(ok({ due_time: "2026-09-19T23:30:00-05:00" }).due_time, "2026-09-20T04:30:00.000Z");
  bad({ due_time: "tonight" }, "invalid_due_time");
});

test("items: at least one, each with a name, a non-negative unit price and an integer quantity", () => {
  bad({ items: [] }, "items_required");
  bad({ items: [{ price: 1 }] }, "invalid_item");
  bad({ items: [{ name: "X", price: -1 }] }, "invalid_item");
  bad({ items: [{ name: "X", price: 1, qty: 0 }] }, "invalid_item");
  bad({ items: [{ name: "X", price: 1, qty: 1.5 }] }, "invalid_item");
  bad({ items: [{ name: "X", price: 1, modifiers: [{ price: 1 }] }] }, "invalid_item");
  const o = ok({ items: [{ name: "X", price: "2.5" }] });
  assert.equal(o.items[0].qty, 1, "qty defaults to one");
  assert.equal(o.items[0].price, 2.5, "a numeric string is money too");
});

test("money must add up: total = subtotal + tax + delivery + service + tip + surcharge - discount, to the cent", () => {
  bad({ money: { subtotal: 40, tax: 3.9, delivery_fee: 4.99, tip: 8, surcharge: 1.2, total: 58.1 } }, "money_mismatch");
  bad({ money: { total: -1 } }, "invalid_money");
  bad({ money: { subtotal: 5000, total: 5000 + 1 } }, "invalid_money");
  const o = ok({ money: { subtotal: 20, tax: 1.95, discount: 5, total: 16.95 } });
  assert.equal(o.money.delivery_fee, 0, "absent parts are zero");
  assert.equal(o.money.discount, 5);
  assert.ok(PHONE_ORDER_MAX_TOTAL >= 1000, "a catering order fits");
});

test("payment: cash | card | house, paid | due, and last4 is exactly four digits or absent", () => {
  bad({ payment: { type: "gift", status: "paid" } }, "invalid_payment");
  bad({ payment: { type: "card", status: "authorized" } }, "invalid_payment");
  bad({ payment: { type: "card", status: "paid", last4: "4111111111111111" } }, "invalid_payment");
  bad({ payment: { type: "card", status: "paid", last4: "12" } }, "invalid_payment");
  assert.equal(ok({ payment: { type: "cash", status: "due" } }).payment.last4, null);
});

console.log("no card numbers:");

test("a run of 13-19 digits, spaced or dashed, is a card number; a phone number or a zip is not", () => {
  assert.ok(looksLikeCardNumber("4111111111111111"));
  assert.ok(looksLikeCardNumber("card 4111 1111 1111 1111 exp 12/28"));
  assert.ok(looksLikeCardNumber("3782-822463-10005"), "15-digit Amex");
  assert.ok(!looksLikeCardNumber("(615) 555-0142"));
  assert.ok(!looksLikeCardNumber("16155550142"));
  assert.ok(!looksLikeCardNumber("5432 Highway 76 East, Springfield, TN 37172"));
  assert.ok(!looksLikeCardNumber(null));
});

test("a card number in any free-text field is refused - notes, item notes, modifier names, the address", () => {
  bad({ notes: "use card 4111 1111 1111 1111" }, "card_number_rejected");
  bad({ customer: { ...body().customer, notes: "4111111111111111" } }, "card_number_rejected");
  bad({ items: [{ name: "X", price: 1, notes: "4111111111111111" }] }, "card_number_rejected");
  bad({ items: [{ name: "X", price: 1, modifiers: [{ name: "4111111111111111" }] }] }, "card_number_rejected");
});

test("the parser's own fixtures carry no card number (the CI grep the brief asks for)", () => {
  assert.ok(!/\d{13,19}/.test(src("lib/phone-order.ts").replace(/4111111111111111/g, "")), "only the guard's own example");
  const fixtures = src("scripts/test-phone-order.ts");
  const stripped = fixtures.replace(/4111 ?1111 ?1111 ?1111|3782-822463-10005/g, "");
  assert.ok(!/(?:\d[ -]?){12,18}\d/.test(stripped), "test fixtures must not contain a PAN beyond the guard's examples");
});

console.log("what the ticket says:");

test("the tender line tells the counter whether to collect, and matches the renderer's rule", () => {
  assert.equal(tenderLine({ type: "card", status: "paid", last4: "8598" }, 58.09), "PAID - CARD ****8598");
  assert.equal(tenderLine({ type: "card", status: "paid", last4: null }, 58.09), "PAID - CARD");
  assert.equal(tenderLine({ type: "card", status: "due", last4: "8598" }, 58.09), "CARD DUE $58.09 (CARD ****8598)");
  assert.equal(tenderLine({ type: "cash", status: "due", last4: null }, 42.1), "CASH DUE $42.10");
  assert.equal(tenderLine({ type: "cash", status: "paid", last4: null }, 42.1), "PAID - CASH");
  assert.equal(tenderLine({ type: "house", status: "due", last4: null }, 42.1), "HOUSE ACCOUNT - DO NOT COLLECT");
  assert.equal(tenderLine({ type: "house", status: "paid", last4: null }, 42.1), "PAID - HOUSE ACCOUNT");
  for (const type of ["cash", "card", "house"] as const) {
    for (const status of ["paid", "due"] as const) {
      const line = tenderLine({ type, status, last4: "1234" }, 1);
      assert.ok(TENDER_LINE_RE.test(line), `${line} must print as an instruction`);
      assert.ok(/^[\x20-\x7e]+$/.test(line), `${line} must be ASCII for the Epson`);
      assert.ok(!/zuppler/i.test(line));
    }
  }
});

test("a phone order's ticket prints PAID - CARD ****8598 bold, with no 'Paid' label", () => {
  const o = ok();
  const canonical = phoneOrderToCanonical(o, { id: "r1", name: "Willie Mae's Kitchen" }, { fingerprint: "f" });
  const lines = buildTicket({ ...canonical, order_number: canonical.orderNumber, ticket_restaurant_name: canonical.ticketRestaurantName, order_type: canonical.orderType, customer_name: canonical.customerName, customer_phone: canonical.customerPhone, customer_address: canonical.customerAddress, items_total: canonical.itemsTotal, delivery_fee: canonical.deliveryFee, customer_total: canonical.customerTotal, payment_type: canonical.paymentType, tip: canonical.tip, tax: canonical.tax, notes: canonical.notes } as any, 48);
  const tender = lines.find((l) => l.text === "PAID - CARD ****8598");
  assert.ok(tender, "the tender line is on the ticket");
  assert.equal(tender!.bold, true);
  const text = toPlainText(lines, 48);
  assert.ok(!/\bPaid\b/.test(text), "no 'Paid' label next to an instruction");
  assert.ok(!/zuppler/i.test(text), "never Zuppler");
  assert.match(text, /TOTAL\s+\$58\.09/);
  assert.match(text, /2\s+SHRIMP PO'BOY\s+\$34\.00/, "line total = qty x (unit + paid modifiers)");
  assert.match(text, />> Extra shrimp \+\$3\.00/);
  assert.match(text, />> no pickles/, "item notes ride as a modifier line");
  assert.match(text, /5432 Highway 76 East, Springfield, TN 37172, Apt\n4/, "address2 joins the street line (wrapped at 48)");
  assert.match(text, />> Gate code 4482/, "customer notes print as a driver instruction");
  assert.ok(toEposPrintXml(lines).includes("PAID - CARD ****8598"));
});

test("a cash order's ticket says CASH DUE $58.09 - the one line that tells the counter to collect", () => {
  const o = ok({ payment: { type: "cash", status: "due" } });
  const c = phoneOrderToCanonical(o, { id: "r1", name: null }, { fingerprint: "f" });
  const text = toPlainText(buildTicket({ payment_type: c.paymentType, customer_total: c.customerTotal, items: c.items } as any, 48), 48);
  assert.match(text, /^CASH DUE \$58\.09$/m);
});

test("a Zuppler order keeps its 'Paid CREDIT' line exactly as before", () => {
  const text = toPlainText(buildTicket({ payment_type: "CREDIT", customer_total: 10, items: [] } as any, 48), 48);
  assert.match(text, /^Paid\s+CREDIT$/m);
});

test("the LAN/USB agent port makes the same choice", () => {
  const agent = src("print-agent/agent.mjs");
  assert.ok(agent.includes("^(PAID - |CASH DUE |CARD DUE |HOUSE ACCOUNT)"), "print-agent/agent.mjs carries the same tender rule as lib/ticket.ts");
});

console.log("the canonical order:");

test("source is phone, the id is the CRM's, and the money lands in the columns accounting reads", () => {
  const c = phoneOrderToCanonical(ok(), { id: "r1", name: "Willie Mae's Kitchen" }, { fingerprint: "abc" });
  assert.equal(c.source, "phone");
  assert.equal(c.externalId, PHONE_ORDER_ID);
  assert.equal(c.restaurantId, "r1");
  assert.equal(c.ticketRestaurantName, "Willie Mae's Kitchen");
  assert.equal(c.orderNumber, "P-0B9A87");
  assert.equal(c.itemsTotal, 40);
  assert.equal(c.tax, 3.9);
  assert.equal(c.deliveryFee, 4.99);
  assert.equal(c.serviceFee, null, "a zero fee is not printed");
  assert.equal(c.tip, 8);
  assert.equal(c.surcharge, 1.2);
  assert.equal(c.customerTotal, 58.09);
  assert.equal(moneyVariance(c), 0, "reconciles at ingest, surcharge included");
  assert.equal(c.notes, "Ring the bell");
  assert.deepEqual((c.rawPayload as any).kind, "phone_order");
  assert.equal((c.rawPayload as any).fingerprint, "abc");
  assert.equal((c.rawPayload as any).actor, "dispatcher@pfdworks.com");
});

test("items take the renderer's shape: quantity folded into the name, one string per modifier, the line total", () => {
  const c = phoneOrderToCanonical(ok(), { id: "r1", name: null }, { fingerprint: "f" });
  assert.deepEqual(c.items[0], { name: "2x Shrimp Po'Boy", price: "$34.00", modifiers: ["Dressed", "Extra shrimp +$3.00", "no pickles"] });
  assert.deepEqual(c.items[1], { name: "Gumbo (cup)", price: "$6.00", modifiers: [] });
});

test("moneyVariance counts a surcharge; an order without one is unchanged", () => {
  assert.equal(moneyVariance({ itemsTotal: 10, tax: 1, tip: 2, surcharge: 0.3, customerTotal: 13.3 }), 0);
  assert.equal(moneyVariance({ itemsTotal: 10, tax: 1, tip: 2, customerTotal: 13.3 }), 0.3, "the old arithmetic sees the surcharge as unexplained");
  assert.equal(moneyVariance({ itemsTotal: 10, tax: 1, tip: 2, customerTotal: 13 }), 0);
});

console.log("idempotency:");

test("the same order fingerprints the same; who retried it does not matter", () => {
  const a = phoneOrderFingerprint(ok());
  assert.equal(phoneOrderFingerprint(ok({ actor: "someone-else@pfdworks.com" })), a);
  assert.equal(phoneOrderFingerprint(ok({ items: [...body().items].map((i) => ({ ...i })) })), a, "key order and copies do not matter");
  assert.equal(a.length, 64);
});

test("a different order under the same id fingerprints differently", () => {
  const a = phoneOrderFingerprint(ok());
  assert.notEqual(phoneOrderFingerprint(ok({ money: { subtotal: 40, tax: 3.9, delivery_fee: 4.99, tip: 9, surcharge: 1.2, total: 59.09 } })), a, "a different tip");
  assert.notEqual(phoneOrderFingerprint(ok({ payment: { type: "cash", status: "due" } })), a, "a different tender");
  assert.notEqual(phoneOrderFingerprint(ok({ items: [{ name: "Gumbo (cup)", price: 6 }] })), a, "different items");
});

test("the stored fingerprint is read back from raw_payload, and only from a phone order's", () => {
  const c = phoneOrderToCanonical(ok(), { id: "r1", name: null }, { fingerprint: "abc" });
  assert.equal(storedFingerprint(c.rawPayload), "abc");
  assert.equal(storedFingerprint({ order: { uuid: "zup" } }), null, "a Zuppler payload");
  assert.equal(storedFingerprint(null), null);
});

console.log("the route (read as source):");

test("POST goes through ingestOrder - the one write path - and never inserts into orders itself", () => {
  const route = src("app/api/crm/orders/route.ts");
  assert.ok(route.includes("export async function POST"));
  assert.ok(route.includes("ingestOrder(phoneOrderToCanonical("));
  assert.ok(!/from\("orders"\)\s*\.insert/.test(route), "no second write path");
  assert.ok(!/print_jobs|notifyRestaurant|deliverToApp/.test(route), "delivery is ingestOrder's job");
});

test("the route answers 200 on an honest retry, 409 on a changed payload or a taken order number, 422 on an unknown restaurant", () => {
  const route = src("app/api/crm/orders/route.ts");
  assert.ok(route.includes('created: false') && route.includes("{ status: 200 }"));
  assert.ok(route.includes('code: "external_id_conflict"') && route.includes("{ status: 409 }"));
  assert.ok(route.includes('code: "order_number_conflict"'));
  assert.ok(route.includes('code: "restaurant_not_found"') && route.includes("{ status: 422 }"));
  assert.ok(route.includes("findRestaurantByRef"), "either id");
  assert.ok(route.includes("authorizeCrmWrite(req)"), "Bearer CRM_WRITE_KEY, 503 when misconfigured");
});

test("ingestOrder treats a phone repeat as a repeat, not a Zuppler-style amendment", () => {
  const canonical = src("lib/canonical.ts");
  assert.ok(canonical.includes('source: "email" | "zuppler" | "test" | "phone"'));
  assert.ok(canonical.includes('if (input.source !== "zuppler") {'), "only Zuppler amends");
  assert.ok(canonical.includes("surcharge: input.surcharge ?? null"), "the surcharge is written");
});

test("migration 042 admits 'phone' and adds the surcharge column; the detail and accounting routes return it", () => {
  const m = src("db/migrations/042_phone_orders.sql");
  assert.match(m, /check \(source in \('email', 'zuppler', 'test', 'phone'\)\)/);
  assert.match(m, /add column if not exists surcharge numeric\(10, 2\)/);
  assert.ok(src("lib/crm-orders-data.ts").includes("discount, surcharge, included_tax"));
  assert.ok(src("app/api/crm/orders/[id]/route.ts").includes("surcharge: num(row.surcharge)"));
  const acct = src("app/api/crm/accounting/orders/route.ts");
  assert.ok(acct.includes("surcharge: num(o.surcharge)") && acct.includes("surcharge: sum((r) => r.money.surcharge)"));
});

test("the tablet's ticket body shows payment_type as stored, so it reads the same instruction as the paper", () => {
  assert.ok(src("components/TicketBody.tsx").includes("{order.payment_type}"));
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
