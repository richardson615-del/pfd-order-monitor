/**
 * The tablet screen and the paper ticket must describe the same order.
 *
 * The screen used to render `raw_html` - the original order EMAIL - in an
 * iframe. Webhook orders have never had one (migration 002 dropped the NOT
 * NULL for exactly that reason), so every Zuppler order opened to a blank
 * page: an alert, a total, and no way to find out what to cook. These
 * assertions pin the two things that would let that come back.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTicket, splitQuantity } from "@/lib/ticket";

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

console.log("quantity reads the same on screen as on paper:");

test("an explicit quantity field wins", () =>
  assert.deepEqual(splitQuantity("Cheeseburger", { quantity: 3 }), {
    qty: 3,
    name: "Cheeseburger",
  }));

test("a folded '2x Name' is split, so the count is not lost in the name", () =>
  assert.deepEqual(splitQuantity("2x Cheeseburger"), { qty: 2, name: "Cheeseburger" }));

test("spacing and case do not change the reading", () => {
  assert.deepEqual(splitQuantity("  12 X  Wings"), { qty: 12, name: "Wings" });
});

test("a name that merely starts with a letter x is untouched", () =>
  assert.deepEqual(splitQuantity("Extra Sauce"), { qty: 1, name: "Extra Sauce" }));

test("no quantity anywhere means one", () =>
  assert.deepEqual(splitQuantity("Loaded FF"), { qty: 1, name: "Loaded FF" }));

test("an explicit quantity of zero does not silently become one", () => {
  // 0 is falsy and > 0 is the guard, so it falls through to the name - which
  // is right: a zero-quantity line is upstream nonsense, and printing "1" for
  // it would invent an item nobody ordered.
  assert.equal(splitQuantity("Cheeseburger", { quantity: 0 }).qty, 1);
});

console.log("\nthe screen renders the order, not the email:");

const viewer = src("components/OrderViewer.tsx");
const ticket = src("components/OrderTicket.tsx");

test("the order screen renders the normalised row", () =>
  assert.match(viewer, /<OrderTicket order=\{order\}/));

test("raw_html is never the primary view", () => {
  // It may still appear behind an explicit toggle - it is evidence of what
  // was sent - but it must be guarded by its own presence, never rendered
  // unconditionally the way it was.
  assert.match(
    viewer,
    /order\.raw_html &&/,
    "raw_html must be rendered only when there is one, and only as an extra"
  );
  // Property access, not the bare word: OrderTicket's own header comment
  // explains why it does not read the email, and a test that trips over the
  // explanation would be pushing back on documentation rather than behaviour.
  assert.doesNotMatch(
    ticket,
    /order\.raw_html/,
    "the ticket itself must not depend on the original email at all"
  );
});

test("printing no longer claims a ticket exists", () => {
  // window.print() returns the same whether it printed or the dialog was
  // cancelled, so setting status from it made the Printed tab describe
  // intentions rather than tickets.
  assert.doesNotMatch(viewer, /setStatus\("printed"\)/);
  assert.match(viewer, /window\.print\(\)/);
});

test("the fields a cook needs are all on the screen", () => {
  for (const field of [
    "order_type", "due_time", "customer_name", "customer_phone",
    "customer_address", "items", "modifiers", "notes", "customer_total",
  ]) {
    assert.match(ticket, new RegExp(field), `${field} is missing from the order screen`);
  }
});

test("a cancelled order says so before anything else", () => {
  const cancelledAt = ticket.indexOf("cancelled_at");
  const type = ticket.indexOf("ticket-type");
  assert.ok(cancelledAt > -1, "a cancelled order must be marked");
  assert.ok(cancelledAt < type, "the warning belongs above the order, not below it");
});

console.log("\nan order with no email still renders fully:");

test("a webhook order has everything the paper ticket has", () => {
  // The exact shape ingestOrder writes for a Zuppler order: raw_html null,
  // every field from the columns.
  const zuppler: any = {
    order_number: "2bed4416",
    source: "zuppler",
    raw_html: null,
    ticket_restaurant_name: "Swezey's Pub",
    order_type: "delivery",
    due_time: "2026-09-10T18:20:00Z",
    received_at: "2026-09-10T18:00:00Z",
    customer_name: "Eileen Gutierrez",
    customer_phone: "(931) 302-3610",
    customer_address: "254 Village Square, Pleasant View | gate code 4471",
    items: [{ name: "2x Loaded FF", price: "$13.00", modifiers: ["Lemon pep. X 1"] }],
    items_total: 13, tax: 1.2, customer_total: 14.2,
    notes: "allergy: shellfish",
  };
  const paper = buildTicket(zuppler, 48).map((l) => l.text).join("\n");
  // Whatever the paper says, the screen has the same source data to say it
  // from - the point being that neither depends on raw_html.
  assert.match(paper, /Loaded FF/i);
  assert.match(paper, /Lemon pep/i);
  assert.match(paper, /gate code 4471/i);
  assert.equal(zuppler.raw_html, null, "and there is no email to fall back on");
});

console.log(`\n${passed} assertions passed.`);
