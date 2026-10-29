/**
 * Sales (PA6, 2026-10-27): the range a restaurant asks for, what it adds up
 * to in cents, the "no price" check (Chef's Market's uncharged item), the
 * receipt, the CSV, and the period chips. The routes are checked by
 * reading their source: session client (RLS), paged reads, no phone or
 * address anywhere.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SALES_COLUMNS,
  SALES_MAX_DAYS,
  centsLabel,
  channelLabel,
  csvCell,
  dayCount,
  orderChecks,
  parseSalesRange,
  paymentLabel,
  rangeDayKeys,
  salesCsv,
  salesCsvName,
  salesQueryWindow,
  salesReceipt,
  salesReport,
  toCents,
  unpricedItems,
  type SalesOrder,
} from "../lib/sales";
import { addDays, includesToday, periodRange } from "../lib/sales-periods";

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

const TZ = "America/Chicago";
// 2026-10-27 18:30 Chicago (CDT, UTC-5).
const NOW = Date.parse("2026-10-27T23:30:00Z");

let n = 0;
function order(over: Partial<SalesOrder> = {}): SalesOrder {
  n++;
  return {
    id: `o${n}`,
    order_number: `10${n}`,
    order_type: "pickup",
    source: "zuppler",
    customer_name: "Rhonda Bogdan",
    items: [{ name: "Brisket Plate", price: "$14.50", modifiers: ["Mac and cheese"] }],
    items_total: 14.5,
    tax: 1.41,
    service_fee: 1,
    delivery_fee: null,
    tip: 2,
    discount: null,
    customer_total: 18.91,
    payment_type: "credit_card",
    status: "completed",
    received_at: "2026-10-27T17:00:00Z",
    cancelled_at: null,
    line_items: null,
    ...over,
  };
}

console.log("money and words:");
test("toCents reads numbers, numeric strings and $ strings; null when absent", () => {
  assert.equal(toCents(18.91), 1891);
  assert.equal(toCents("18.91"), 1891);
  assert.equal(toCents("$1,234.50"), 123450);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(null), null);
  assert.equal(toCents(""), null);
  assert.equal(toCents("n/a"), null);
});
test("centsLabel", () => {
  assert.equal(centsLabel(0), "$0.00");
  assert.equal(centsLabel(123450), "$1,234.50");
  assert.equal(centsLabel(-305), "-$3.05");
});
test("channel and payment labels a restaurant reads", () => {
  assert.equal(channelLabel("zuppler"), "Online");
  assert.equal(channelLabel("email"), "Online");
  assert.equal(channelLabel("phone"), "Phone");
  assert.equal(channelLabel("ezcater"), "Catering");
  // A restaurant never sees the name, including on a row stored before the change.
  assert.equal(paymentLabel("ezCater (prepaid)"), "Catering (prepaid)");
  assert.equal(channelLabel("ubereats"), "Uber Eats");
  assert.equal(channelLabel(null), "Other");
  assert.equal(paymentLabel("credit_card"), "Card");
  assert.equal(paymentLabel("Braintree"), "Card");
  assert.equal(paymentLabel("CASH"), "Cash");
  assert.equal(paymentLabel(""), "Not given");
  assert.equal(paymentLabel("gift_card"), "Card");
  assert.equal(paymentLabel("house_account"), "On account");
});

console.log("the no-price check (Chef's Market):");
test("an item with no price, or $0, is flagged; free / no charge lines are not", () => {
  assert.deepEqual(
    unpricedItems([
      { name: "Brisket Plate", price: "$14.50", modifiers: [] },
      { name: "Banana Pudding", price: null, modifiers: [] },
      { name: "Sweet Tea", price: "$0.00", modifiers: [] },
      { name: "Free cookie", price: "$0.00", modifiers: [] },
      { name: "Utensils (no charge)", price: null, modifiers: [] },
    ]),
    ["Banana Pudding", "Sweet Tea"]
  );
});
test("orderChecks: one item named, several counted, cancelled and test orders never checked", () => {
  assert.deepEqual(orderChecks(order({ items: [{ name: "Ribs", price: null, modifiers: [] }] })), ["No price on Ribs"]);
  assert.deepEqual(
    orderChecks(order({ items: [{ name: "A", price: null, modifiers: [] }, { name: "B", price: "0", modifiers: [] }] })),
    ["No price on 2 items"]
  );
  assert.deepEqual(orderChecks(order()), []);
  assert.deepEqual(orderChecks(order({ status: "cancelled", items: [{ name: "Ribs", price: null, modifiers: [] }] })), []);
  assert.deepEqual(orderChecks(order({ source: "test", items: [{ name: "Ribs", price: null, modifiers: [] }] })), []);
});

console.log("the range:");
test("defaults to today, in the restaurant's day", () => {
  assert.deepEqual(parseSalesRange(null, null, NOW, TZ), { ok: true, range: { from: "2026-10-27", to: "2026-10-27" } });
  // 04:30 UTC on the 28th is still the 27th in Chicago.
  assert.deepEqual(parseSalesRange(null, null, Date.parse("2026-10-28T04:30:00Z"), TZ), { ok: true, range: { from: "2026-10-27", to: "2026-10-27" } });
});
test("refuses bad dates, a backwards range, and more than a year", () => {
  assert.equal(parseSalesRange("10/27/2026", null, NOW, TZ).ok, false);
  assert.equal(parseSalesRange("2026-02-30", "2026-03-01", NOW, TZ).ok, false);
  assert.equal(parseSalesRange("2026-10-27", "2026-10-01", NOW, TZ).ok, false);
  assert.equal(parseSalesRange("2025-01-01", "2026-10-27", NOW, TZ).ok, false);
  assert.equal(parseSalesRange("2025-10-27", "2026-10-27", NOW, TZ).ok, true);
  assert.equal(dayCount({ from: "2025-10-27", to: "2026-10-27" }), SALES_MAX_DAYS);
});
test("rangeDayKeys steps one day at a time across a DST change", () => {
  assert.deepEqual(rangeDayKeys({ from: "2026-10-31", to: "2026-11-03" }), ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
});
test("the query window has a day of slack either side", () => {
  const w = salesQueryWindow({ from: "2026-10-27", to: "2026-10-27" });
  assert.equal(w.since, "2026-10-26T00:00:00.000Z");
  assert.equal(w.until, "2026-10-29T00:00:00.000Z");
});

console.log("the report:");
test("adds up in cents: food after discount, what customers paid, tax, fees, tips, average", () => {
  const r = salesReport(
    [
      order({ received_at: "2026-10-27T17:00:00Z" }),
      order({
        received_at: "2026-10-27T18:00:00Z",
        order_type: "delivery",
        items_total: 20,
        discount: 2,
        tax: 1.8,
        service_fee: null,
        delivery_fee: 4.99,
        tip: 3,
        customer_total: 27.79,
        source: "phone",
        payment_type: "cash",
      }),
    ],
    { from: "2026-10-27", to: "2026-10-27" },
    NOW,
    TZ
  );
  assert.equal(r.totals.orders, 2);
  assert.equal(r.totals.food_cents, 1450 + 1800);
  assert.equal(r.totals.paid_cents, 1891 + 2779);
  assert.equal(r.totals.tax_cents, 141 + 180);
  assert.equal(r.totals.fees_cents, 100 + 499);
  assert.equal(r.totals.tip_cents, 200 + 300);
  assert.equal(r.totals.discount_cents, 200);
  assert.equal(r.totals.average_cents, Math.round((1891 + 2779) / 2));
  assert.deepEqual(r.channels.map((c) => c.label), ["Phone", "Online"]);
  assert.deepEqual(r.payments.map((c) => [c.label, c.orders]), [["Cash", 1], ["Card", 1]]);
  assert.equal(r.days.length, 1);
  assert.equal(r.days[0].label, "Today");
  assert.equal(r.rows[0].order_number, r.rows[0].order_number);
  assert.equal(r.rows[0].time, "1:00 PM"); // newest first, Chicago time
});
test("cancelled orders are listed and totalled apart; test orders vanish; out-of-range days are dropped", () => {
  const r = salesReport(
    [
      order({ status: "cancelled", cancelled_at: "2026-10-27T17:10:00Z", customer_total: 10 }),
      order({ source: "test" }),
      order({ received_at: "2026-10-26T04:00:00Z" }), // Oct 25 in Chicago
      order(),
    ],
    { from: "2026-10-26", to: "2026-10-27" },
    NOW,
    TZ
  );
  assert.equal(r.totals.orders, 1);
  assert.deepEqual(r.totals.cancelled, { orders: 1, paid_cents: 1000 });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows.filter((x) => x.cancelled).length, 1);
  assert.deepEqual(r.days.map((d) => [d.key, d.orders]), [["2026-10-26", 0], ["2026-10-27", 1]]);
});
test("to_check counts orders with an unpriced item, and the row says which", () => {
  const r = salesReport([order({ items: [{ name: "Banana Pudding", price: null, modifiers: [] }] }), order()], { from: "2026-10-27", to: "2026-10-27" }, NOW, TZ);
  assert.equal(r.totals.to_check, 1);
  assert.deepEqual(r.rows.flatMap((x) => x.checks), ["No price on Banana Pudding"]);
});
test("best sellers use structured quantities, else '2x Name' on the ticket line", () => {
  const r = salesReport(
    [
      order({ line_items: [{ name: "Brisket Plate", quantity: 3, item_total: 43.5 }] }),
      order({ items: [{ name: "2x Brisket Plate", price: "$29.00", modifiers: [] }, { name: "Sweet Tea", price: "$2.50", modifiers: [] }] }),
    ],
    { from: "2026-10-27", to: "2026-10-27" },
    NOW,
    TZ
  );
  assert.deepEqual(r.top_items, [
    { name: "Brisket Plate", quantity: 5 },
    { name: "Sweet Tea", quantity: 1 },
  ]);
});
test("rows carry the first name only, never a phone or address", () => {
  const r = salesReport([order({ customer_name: "Rhonda Bogdan" })], { from: "2026-10-27", to: "2026-10-27" }, NOW, TZ);
  assert.equal(r.rows[0].customer, "Rhonda");
  assert.ok(!/phone|address/.test(SALES_COLUMNS));
});

console.log("the receipt:");
test("items with prices, the unpriced one marked, lines without zeros, discount negative", () => {
  const rc = salesReceipt(
    order({
      items: [
        { name: "Brisket Plate", price: "$14.50", modifiers: ["Mac and cheese"] },
        { name: "Banana Pudding", price: null, modifiers: [] },
      ],
      discount: 1.5,
      delivery_fee: 0,
    }),
    TZ
  );
  assert.deepEqual(rc.items.map((i) => [i.name, i.price_cents, i.unpriced]), [
    ["Brisket Plate", 1450, false],
    ["Banana Pudding", null, true],
  ]);
  assert.deepEqual(rc.lines.map((l) => [l.label, l.cents]), [
    ["Items", 1450],
    ["Discount", -150],
    ["Tax", 141],
    ["Service fee", 100],
    ["Tip", 200],
  ]);
  assert.equal(rc.payment, "Card");
  assert.deepEqual(rc.checks, ["No price on Banana Pudding"]);
});

console.log("the CSV:");
test("cells are quoted when needed and a leading = cannot become a formula", () => {
  assert.equal(csvCell('Ribs, "large"'), '"Ribs, ""large"""');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(null), "");
});
test("one line per order, oldest first, cancelled marked, unpriced items named, tests dropped", () => {
  const csv = salesCsv(
    [
      order({ received_at: "2026-10-27T18:00:00Z", items: [{ name: "Ribs", price: null, modifiers: [] }] }),
      order({ received_at: "2026-10-27T17:00:00Z", status: "cancelled" }),
      order({ source: "test" }),
    ],
    { from: "2026-10-27", to: "2026-10-27" },
    TZ
  );
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("Date,Time,Order,Channel,Type,Customer,Items,Item sales,Discount,Tax"));
  assert.ok(lines[1].includes("12:00 PM") && lines[1].includes("Cancelled"));
  assert.ok(lines[2].includes("Ribs (no price)") && lines[2].includes("No price on Ribs"));
  assert.ok(!csv.includes("Bogdan"));
  assert.equal(salesCsvName({ from: "2026-10-01", to: "2026-10-27" }), "sales-2026-10-01-to-2026-10-27.csv");
  assert.equal(salesCsvName({ from: "2026-10-27", to: "2026-10-27" }), "sales-2026-10-27.csv");
});

console.log("the period chips:");
test("today, yesterday, 7 and 30 days, this month, last month, in the restaurant's day", () => {
  assert.deepEqual(periodRange("today", NOW, TZ), { from: "2026-10-27", to: "2026-10-27" });
  assert.deepEqual(periodRange("yesterday", NOW, TZ), { from: "2026-10-26", to: "2026-10-26" });
  assert.deepEqual(periodRange("7d", NOW, TZ), { from: "2026-10-21", to: "2026-10-27" });
  assert.deepEqual(periodRange("30d", NOW, TZ), { from: "2026-09-28", to: "2026-10-27" });
  assert.deepEqual(periodRange("month", NOW, TZ), { from: "2026-10-01", to: "2026-10-27" });
  assert.deepEqual(periodRange("lastmonth", NOW, TZ), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(periodRange("lastmonth", Date.parse("2026-03-15T18:00:00Z"), TZ), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(includesToday(periodRange("7d", NOW, TZ), NOW, TZ), true);
  assert.equal(includesToday(periodRange("lastmonth", NOW, TZ), NOW, TZ), false);
});

console.log("the routes:");
test("every sales route reads through the session client and the signed-in restaurant", () => {
  const server = src("lib/sales-server.ts");
  assert.ok(server.includes("supabaseServer()"));
  assert.ok(server.includes("getCurrentUserRestaurantIds"));
  assert.ok(!/admin|service_role|SERVICE_ROLE/.test(server.replace(/\/\*[\s\S]*?\*\//g, "")));
  assert.ok(server.includes(".range(offset, offset + PAGE - 1)"), "paged: one read is capped at 1000 rows");
  for (const p of ["app/api/dashboard/sales/route.ts", "app/api/dashboard/sales/export/route.ts", "app/api/dashboard/sales/[id]/route.ts"]) {
    const s = src(p);
    assert.ok(s.includes("salesCaller()"), `${p} uses salesCaller`);
  }
  assert.ok(src("app/api/dashboard/sales/[id]/route.ts").includes('.eq("restaurant_id", caller.restaurantId)'));
  assert.ok(src("app/api/dashboard/sales/export/route.ts").includes("text/csv"));
});
test("the dashboard shows Sales where Past week was", () => {
  const d = src("components/OrderDashboard.tsx");
  assert.ok(d.includes('label: "Sales"'));
  assert.ok(d.includes("<SalesTab timezone={timezone} />"));
});

console.log(`\n${passed} passed`);
