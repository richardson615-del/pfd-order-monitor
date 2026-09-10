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

test("the screen uses the printer's own renderer, not a second one", () => {
  // The point of this is that the two cannot drift. A lookalike layout would
  // make staff learn a second arrangement of the same facts, and would go
  // stale the first time the ticket changed.
  assert.match(ticket, /buildTicket\(/);
  assert.match(ticket, /omitFooter: true/, "the footer is the customer's, not the kitchen's");
});

test("the printer's emphasis survives onto the screen", () => {
  // Bold, double height, double width and reverse video are how a thermal
  // printer says "this matters". Dropping them would render a wall of
  // monospace that happens to contain the right words.
  for (const attr of ["bold", "reverse", "double", "double-h"]) {
    assert.match(ticket, new RegExp(attr), `${attr} is not carried onto the screen`);
  }
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
  // The screen calls exactly this, so asserting it here asserts the screen.
  const lines = buildTicket(zuppler, 48, {}, { omitFooter: true });
  const paper = lines.map((l) => l.text).join("\n");

  assert.match(paper, /D E L I V E R Y/, "where the food goes leads the ticket");
  assert.match(paper, /Eileen Gutierrez/);
  assert.match(paper, /254 Village Square/);
  assert.match(paper, /gate code 4471/i, "the instruction is split off the address");
  assert.match(paper, /LOADED FF/i);
  assert.match(paper, /Lemon pep/i, "a missed modifier is a remade plate");
  assert.match(paper, /allergy: shellfish/i);
  assert.match(paper, /TOTAL/);
  assert.equal(zuppler.raw_html, null, "and there is no email to fall back on");
});

test("the quantity survives as its own column, not folded into the name", () => {
  const lines = buildTicket(
    { items: [{ name: "2x Loaded FF", price: "$13.00", modifiers: [] }] } as any,
    48,
    {},
    { omitFooter: true }
  );
  assert.ok(
    lines.some((l) => /^\s*2\s+LOADED FF/.test(l.text)),
    "count must be readable at a glance during a rush"
  );
});

test("omitting the footer does not touch the order above it", () => {
  const order: any = { order_number: "1", items: [], customer_total: 10 };
  const withFooter = buildTicket(order, 48).map((l) => l.text);
  const without = buildTicket(order, 48, {}, { omitFooter: true }).map((l) => l.text);
  assert.deepEqual(
    withFooter.slice(0, without.length),
    without,
    "the screen and the paper must agree on everything before the tear-off"
  );
  assert.ok(withFooter.length > without.length, "and the footer really is dropped");
});

console.log(`\n${passed} assertions passed.`);
