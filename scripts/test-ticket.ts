/**
 * Assertions for the shared ticket renderer / ePOS-Print XML output.
 * Run via `npm test`.
 */
import assert from "node:assert/strict";
import { buildTicket, toEposPrintXml, xmlEscape } from "@/lib/ticket";

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

const ORDER = {
  order_number: "7c753db5",
  source: "zuppler",
  ticket_restaurant_name: "Yummy Johns",
  order_type: "delivery",
  customer_name: "Mac Baggett",
  customer_phone: "6153473239",
  customer_address: "5432 Highway 76 East, Springfield, TN 37172",
  items: [
    { name: "Clear Soup", price: "$2.50", modifiers: [] },
    { name: "3x Pepper Tuna App", price: "$23.85", modifiers: ["Add wasabi & soy <sauce>"] },
  ],
  items_total: 50.25, tax: 4.9, service_fee: 14.57,
  delivery_fee: 6.06, tip: 11.37, customer_total: 87.15,
  payment_type: "CREDIT",
  notes: "Gate code 4482 | Leave at door",
};

console.log("ticket renderer:");

test("no line exceeds the paper width (48 cols)", () => {
  for (const l of buildTicket(ORDER, 48)) {
    assert.ok(l.text.length <= 48, `overflow (${l.text.length}): ${l.text}`);
  }
});

test("no line exceeds the paper width (32 cols)", () => {
  for (const l of buildTicket(ORDER, 32)) {
    assert.ok(l.text.length <= 32, `overflow (${l.text.length}): ${l.text}`);
  }
});

test("tip prints on its own labelled line", () => {
  const lines = buildTicket(ORDER, 48);
  assert.ok(lines.some((l) => /TIP \(driver\)/.test(l.text) && /11\.37/.test(l.text)));
});

test("every money field appears on the ticket", () => {
  const t = buildTicket(ORDER, 48).map((l) => l.text).join("\n");
  for (const v of ["50.25", "4.90", "14.57", "6.06", "11.37", "87.15"]) {
    assert.ok(t.includes(v), `missing ${v}`);
  }
});

test("missing money fields are omitted, not printed as $0.00 or NaN", () => {
  const t = buildTicket({ order_number: "1", items: [] }, 48).map((l) => l.text).join("\n");
  assert.ok(!/NaN/.test(t));
  assert.ok(!/\$0\.00/.test(t));
  assert.ok(/no itemization available/.test(t));
});

test("a due time before the order is marked (PAST), not shown as urgent", () => {
  const t = buildTicket(
    { ...ORDER, received_at: "2026-08-13T02:00:00Z", due_time: "2026-08-10T22:30:00Z" },
    48
  ).map((l) => l.text).join("\n");
  assert.match(t, /DUE .*\(PAST\)/);
});

test("a normal future due time is not marked", () => {
  const t = buildTicket(
    { ...ORDER, received_at: "2026-08-13T02:00:00Z", due_time: "2026-08-13T02:45:00Z" },
    48
  ).map((l) => l.text).join("\n");
  assert.ok(/DUE /.test(t));
  assert.ok(!/\(PAST\)/.test(t));
});

console.log("epos-print xml:");

test("xml escapes markup in customer data", () => {
  const x = toEposPrintXml(buildTicket(ORDER, 48), 48);
  assert.ok(x.includes("&amp;"), "ampersand not escaped");
  assert.ok(x.includes("&lt;sauce&gt;"), "angle brackets not escaped");
  // No raw < > from the data may leak into the markup.
  assert.ok(!/<sauce>/.test(x));
});

test("xmlEscape handles all five entities", () =>
  assert.equal(xmlEscape(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;"));

test("xml is well-formed and cuts once", () => {
  const x = toEposPrintXml(buildTicket(ORDER, 48), 48);
  assert.equal((x.match(/<cut /g) || []).length, 1);
  assert.ok(x.startsWith("<epos-print xmlns="));
  assert.ok(x.endsWith("</epos-print>"));
  assert.equal((x.match(/<text /g) || []).length, (x.match(/<\/text>/g) || []).length);
});

test("double-width falls back when the line would overflow", () => {
  // Tested against the renderer directly. buildTicket no longer emits any
  // double-WIDTH line - the restaurant name that used to be one was demoted
  // when the type/DUE block took the headline - but the primitive is still
  // part of the renderer's contract and still protects any caller using it.
  const x = toEposPrintXml(
    [{ text: "A Very Long Restaurant Name Indeed", size: "double", align: "center" }],
    48
  );
  assert.match(x, /width="1"/, "long heading must not stay double-width");
  assert.match(x, /height="2"/, "but should still be emphasised");
  const short = toEposPrintXml([{ text: "Short", size: "double" }], 48);
  assert.match(short, /width="2"/, "a short line keeps double width");
});

console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
