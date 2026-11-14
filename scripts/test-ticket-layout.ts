/**
 * Layout tests for the kitchen ticket.
 * These assert the things a cook depends on, not cosmetics.
 */
import assert from "node:assert/strict";
import { buildTicket, toEposPrintXml, DEFAULT_FOOTER_TEXT, splitTicketNotes, splitModifierPrice, splitItemNote } from "@/lib/ticket";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const base: any = {
  order_number: "abc12345", ticket_restaurant_name: "Ariella Restaurant Bistro & Bar",
  order_type: "pickup", due_time: "2026-08-27T02:29:33Z", received_at: "2026-08-27T02:14:33Z",
  customer_name: "Jane Doe", customer_phone: "615-555-0100",
  items: [{ name: "2x Cheeseburger", price: "$23.00", modifiers: ["NO ONIONS"] }],
  items_total: 23, customer_total: 25.5,
};
const text = (l: any[]) => l.map((x) => x.text).join("\n");

console.log("ticket layout:");

test("the order TYPE is the first thing printed", () => {
  const first = buildTicket(base, 48)[0];
  assert.match(first.text, /P *I *C *K *U *P/);
  assert.equal(first.reverse, true, "type must use the strongest emphasis available");
});

test("DUE follows immediately, at double height", () => {
  const l = buildTicket(base, 48)[1];
  assert.match(l.text, /^DUE /);
  assert.equal(l.size, "double-h");
});

test("the restaurant name is present but no longer the headline", () => {
  const lines = buildTicket(base, 48);
  const i = lines.findIndex((l) => l.text.includes("Ariella"));
  assert.ok(i > 1, "name must not lead the ticket");
  assert.notEqual(lines[i].size, "double", "name must not take double width");
});

test("quantity is its own column, not folded into the name", () => {
  const l = buildTicket(base, 48).find((x) => /CHEESEBURGER/.test(x.text))!;
  assert.match(l.text, /^\s+2\s+CHEESEBURGER/);
  assert.ok(!/2x/i.test(l.text), "'2x Cheeseburger' must be unfolded");
});

test("an explicit quantity field wins over the name prefix", () => {
  const o = { ...base, items: [{ name: "Wings", quantity: 3, price: "$9.00" }] };
  assert.match(buildTicket(o, 48).find((x) => /WINGS/.test(x.text))!.text, /^\s+3\s+WINGS/);
});

test("modifiers are BOLD - a missed one is a remade plate", () => {
  const l = buildTicket(base, 48).find((x) => /NO ONIONS/.test(x.text))!;
  assert.equal(l.bold, true);
  assert.match(l.text, /^\s+- NO ONIONS/);
});

test("delivery instructions are split off the street address", () => {
  const o = { ...base, order_type: "delivery",
    customer_address: "4445 Mount Zion Road, Springfield, TN 37172 | Ring the bell" };
  const out = text(buildTicket(o, 48));
  assert.ok(!/37172 \|/.test(out), "the pipe separator must not print");
  assert.match(out, /^>> Ring the bell$/m);
});

test("no line exceeds the paper width", () => {
  const o = { ...base, order_type: "delivery",
    customer_address: "A very long street address that will certainly need wrapping, Springfield, TN 37172 | Ring the bell twice and wait",
    items: [{ name: "An extremely long item name that must wrap cleanly across lines", price: "$12.00", modifiers: ["A modifier long enough to need wrapping as well"] }] };
  for (const l of buildTicket(o, 48)) {
    if (l.qr) continue;
    assert.ok(l.text.length <= 48, `overflow (${l.text.length}): ${l.text}`);
  }
});

// TK2 (Matt 2026-11-14, The Depot's order #63): the ticket a kitchen can read at a glance.
const depot: any = { ...base, items: [
  { name: "2x Grilled Atlantic Salmon", price: "$54.00", note: "No tortillas strips on salad, but add the fried chicken",
    modifiers: ["6 Oz +$19.00", "Loaded Garlic Mashed Potatoes", "Steamed Broccoli +$4.00", "No tortillas strips on salad, but add the fried chicken"] },
  { name: "Twin Pork Chops", price: "$29.00", modifiers: ["Sweet Potato Fries"] },
] };

test("TK3: in large print a choice is the item's size; a price shares its line only when it fits, else sits right-aligned under it with no dash", () => {
  const lines = buildTicket(depot, 48, {}, { scale: "large" });
  const side = lines.find((l) => /- Loaded Garlic/.test(l.text))!;
  assert.equal(side.size, "double", "sides and add-ons print as large as the item (Matt 2026-11-14)");
  assert.ok(side.text.length <= 24);
  const oz = lines.find((l) => /- 6 Oz/.test(l.text))!;
  assert.match(oz.text, /^\s+- 6 Oz\s+\+\$19\.00$/);
  assert.equal(oz.text.length, 24);
  const broc = lines.findIndex((l) => /- Steamed Broccoli$/.test(l.text));
  assert.ok(broc > 0, "too long to share the line");
  assert.match(lines[broc + 1].text, /^\s+\+\$4\.00$/);
  assert.ok(!/-\s/.test(lines[broc + 1].text), "the price line carries no dash");
  for (const l of lines) if (!l.qr && l.size === "double") assert.ok(l.text.length <= 24, `overflow at double width: ${l.text}`);
});

test("TK3: in large print the fine print is tall, and stays at the base size in normal print", () => {
  const big = buildTicket({ ...depot, items_total: 83, tax: 8 }, 48, {}, { scale: "large" });
  for (const re of [/^ORDER #/, /^615-555-0100$/, /QTY\s+ITEM/, /^Subtotal/, /^Tax/, /MAKE 2 - EACH WITH:/, /NOTE FOR THIS ITEM:/]) {
    const l = big.find((x) => re.test(x.text));
    assert.ok(l, `missing ${re}`);
    assert.equal(l!.size, "double-h", `${re} should print tall`);
  }
  const normal = buildTicket({ ...depot, items_total: 83 }, 48);
  assert.equal(normal.find((x) => /^Subtotal/.test(x.text))!.size, undefined);
  assert.equal(normal.find((x) => /- Loaded Garlic Mashed Potatoes$/.test(x.text))!.size, undefined);
});

test("TK2: a wrapped choice continues without a dash, so it cannot read as two choices", () => {
  const o = { ...base, items: [{ name: "Plate", price: "$9.00", modifiers: ["A choice with a name long enough that it has to wrap onto a second line"] }] };
  const lines = buildTicket(o, 48).map((l) => l.text);
  const i = lines.findIndex((x) => /- A choice with/.test(x));
  assert.ok(i > 0 && !/-/.test(lines[i + 1]), `continuation has no dash: ${lines[i + 1]}`);
  assert.match(lines[i + 1], /^\s{7,}\S/);
});

test("TK2: the customer's note on an item is set apart from the choices, once", () => {
  const lines = buildTicket(depot, 48, {}, { scale: "large" }).map((l) => l.text);
  const head = lines.findIndex((x) => /NOTE FOR THIS ITEM:/.test(x));
  assert.ok(head > 0);
  assert.match(lines[head + 1], /No tortillas/);
  assert.equal(lines.filter((x) => /No tortillas/.test(x)).length, 1, "not also printed as a choice");
  assert.deepEqual(splitItemNote({ modifiers: ["Ranch", "extra crispy"] }), { mods: ["Ranch", "extra crispy"], note: null }, "an order stored before TK2 prints as before");
});

test("TK2: two of an item says so above its choices; items are divided by a dotted rule", () => {
  const lines = buildTicket(depot, 48, {}, { scale: "large" }).map((l) => l.text);
  assert.ok(lines.some((x) => /MAKE 2 - EACH WITH:/.test(x)));
  const pork = lines.findIndex((x) => /TWIN PORK CHOPS/.test(x));
  assert.match(lines[pork - 1], /^(\. )+\.?$/);
  const plain = { ...base, items: [{ name: "2x Fries", price: "$6.00", modifiers: [] }] };
  assert.ok(!buildTicket(plain, 48).some((l) => /MAKE 2/.test(l.text)), "nothing to say when there are no choices");
});

test("TK2: a price that does not fit beside a large item name prints right under it, never above the next item", () => {
  const lines = buildTicket(depot, 48, {}, { scale: "large" });
  const pork = lines.findIndex((l) => /TWIN PORK CHOPS/.test(l.text));
  assert.match(lines[pork + 1].text, /^\s+\$29\.00$/);
  assert.equal(lines[pork + 1].size, "double");
  assert.equal(lines[lines.length - 1 - [...lines].reverse().findIndex((l) => /\$29\.00/.test(l.text))], lines[pork + 1], "and nowhere else");
});

test("TK2: splitModifierPrice", () => {
  assert.deepEqual(splitModifierPrice("Add Fried Chicken +$4.00"), { label: "Add Fried Chicken", price: "+$4.00" });
  assert.deepEqual(splitModifierPrice("2x Ranch"), { label: "2x Ranch", price: null });
});

test("the footer falls back to the global default", () =>
  assert.ok(text(buildTicket(base, 48, {})).includes(DEFAULT_FOOTER_TEXT.split("\n")[0])));

test("a restaurant footer overrides the default", () => {
  const out = text(buildTicket(base, 48, { text: "Thanks for ordering direct!" }));
  assert.ok(out.includes("Thanks for ordering direct!"));
  assert.ok(!out.includes("Powered by Premium"));
});

test("whitespace precedes the footer so it survives a tear-off", () => {
  const lines = buildTicket(base, 48, { text: "Bye" });
  const i = lines.findIndex((l) => l.text === "Bye");
  const blanks = lines.slice(Math.max(0, i - 4), i).filter((l) => l.text === "").length;
  assert.ok(blanks >= 4, `expected >=4 blank lines before the footer, got ${blanks}`);
});

test("no QR line when the restaurant has no url", () =>
  assert.equal(buildTicket(base, 48, { text: "Bye" }).some((l) => l.qr), false));

test("a url produces a QR symbol in the XML", () => {
  const xml = toEposPrintXml(buildTicket(base, 48, { url: "https://ariella.zuppler.com" }), 48);
  assert.match(xml, /<symbol type="qrcode_model_2"[^>]*>https:\/\/ariella\.zuppler\.com<\/symbol>/);
});

test("the note prints with the items, larger, before the money (Charlie's 2026-11-12)", () => {
  const o = { ...base, items_total: 23, notes: "Add extra egg and tomato to salad | Discount applied: $8.00" };
  const lines = buildTicket(o, 48);
  const bar = lines.findIndex((l) => l.text.trim() === "NOTE");
  const item = lines.findIndex((l) => /CHEESEBURGER/.test(l.text));
  const sub = lines.findIndex((l) => /^Subtotal/.test(l.text));
  assert.ok(item < bar && bar < sub, "NOTE sits between the items and the subtotal");
  assert.equal(lines[bar].reverse, true);
  const note = lines[bar + 1];
  assert.match(note.text, /Add extra egg and tomato/);
  assert.equal(note.size, "double-h");
  assert.equal(note.bold, true);
  assert.ok(!text(lines).includes("Discount applied"), "the discount is not a kitchen note");
  assert.match(text(lines), /Discount +-\$8\.00/);
  const big = buildTicket(o, 48, {}, { scale: "large" });
  assert.equal(big[big.findIndex((l) => l.text.trim() === "NOTE") + 1].size, "double");
});

test("splitTicketNotes keeps the note and pulls the discount out", () => {
  assert.deepEqual(splitTicketNotes("Ring the bell | Discount applied: $8.00"), { kitchen: "Ring the bell", discount: "-$8.00" });
  assert.deepEqual(splitTicketNotes("Discount applied: $2.5"), { kitchen: null, discount: "-$2.50" });
  assert.deepEqual(splitTicketNotes("Gate 4 | side door"), { kitchen: "Gate 4 | side door", discount: null });
  assert.deepEqual(splitTicketNotes(null), { kitchen: null, discount: null });
});

test("reverse video is emitted for the type banner only", () => {
  const xml = toEposPrintXml(buildTicket(base, 48), 48);
  assert.equal((xml.match(/reverse="true"/g) ?? []).length, 1);
});

test("a past due time is still marked (PAST)", () => {
  const o = { ...base, due_time: "2026-08-27T02:00:00Z", received_at: "2026-08-27T02:14:33Z" };
  assert.match(buildTicket(o, 48)[1].text, /\(PAST\)/);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
