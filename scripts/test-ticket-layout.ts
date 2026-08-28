/**
 * Layout tests for the kitchen ticket.
 * These assert the things a cook depends on, not cosmetics.
 */
import assert from "node:assert/strict";
import { buildTicket, toEposPrintXml, DEFAULT_FOOTER_TEXT } from "@/lib/ticket";

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
  assert.match(l.text, /^\s+>> NO ONIONS/);
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

test("reverse video is emitted for the type banner only", () => {
  const xml = toEposPrintXml(buildTicket(base, 48), 48);
  assert.equal((xml.match(/reverse="true"/g) ?? []).length, 1);
});

test("a past due time is still marked (PAST)", () => {
  const o = { ...base, due_time: "2026-08-27T02:00:00Z", received_at: "2026-08-27T02:14:33Z" };
  assert.match(buildTicket(o, 48)[1].text, /\(PAST\)/);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
