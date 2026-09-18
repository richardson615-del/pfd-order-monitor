/**
 * Today's orders, for the office (M1, Nick 2026-09-18).
 *
 * The rules a CRM order dashboard rests on: which instants make up a
 * Chicago day (including the two days a year that are not 24 hours), what
 * a list row may carry (the phone's last four, never the whole number),
 * what the paper channel is said to have done, which flags the tablet's
 * own helpers raise, the tablet's sort applied across restaurants, and
 * the two actions the office may take because the primitives existed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_ORDERS_TZ,
  PRINT_STUCK_MS,
  UNACCEPTED_FLAG_MS,
  appDelivery,
  changedSince,
  isOrderAction,
  localDayWindow,
  orderCounts,
  orderFlags,
  orderTimeline,
  phoneLast4,
  printSummary,
  shapeOrderRow,
  sortOrderRows,
  type OrderRowInput,
  type PrintJobRow,
} from "../lib/crm-orders";
import { kitchenSort } from "../lib/countdown";
import { localDayKey } from "../lib/local-day";

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
const NOW = Date.parse("2026-09-18T23:30:00Z"); // 6:30 PM Chicago
const M = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

console.log("the day:");

test("a Chicago day in September runs 05:00Z to 05:00Z; the window is half-open", () => {
  const w = localDayWindow("2026-09-18", TZ)!;
  assert.equal(w.start, "2026-09-18T05:00:00.000Z");
  assert.equal(w.end, "2026-09-19T05:00:00.000Z");
  assert.equal(localDayKey(w.start, TZ), "2026-09-18");
  assert.equal(localDayKey(Date.parse(w.end) - 1, TZ), "2026-09-18");
  assert.equal(localDayKey(w.end, TZ), "2026-09-19");
});

test("the clocks going back (2026-11-01) is a 25-hour day; going forward (2026-03-08) is 23", () => {
  const back = localDayWindow("2026-11-01", TZ)!;
  assert.equal(back.start, "2026-11-01T05:00:00.000Z", "midnight CDT");
  assert.equal(back.end, "2026-11-02T06:00:00.000Z", "midnight CST");
  assert.equal(Date.parse(back.end) - Date.parse(back.start), 25 * 3_600_000);
  const fwd = localDayWindow("2026-03-08", TZ)!;
  assert.equal(Date.parse(fwd.end) - Date.parse(fwd.start), 23 * 3_600_000);
  // UTC is the trivial case.
  assert.deepEqual(localDayWindow("2026-09-18", "UTC"), { start: "2026-09-18T00:00:00.000Z", end: "2026-09-19T00:00:00.000Z" });
});

test("a date that is not YYYY-MM-DD, or a zone Intl does not know, is null - a 400, never a guess", () => {
  assert.equal(localDayWindow("2026-9-18", TZ), null);
  assert.equal(localDayWindow("today", TZ), null);
  assert.equal(localDayWindow("2026-09-18", "Mars/Olympus"), null);
  assert.equal(DEFAULT_ORDERS_TZ, "America/Chicago");
});

console.log("\nthe row:");

const order = (id: string, over: Partial<OrderRowInput> = {}): OrderRowInput => ({
  id,
  order_number: id.toUpperCase(),
  source: "zuppler",
  status: "new",
  restaurant_id: "r1",
  received_at: at(NOW - 5 * M),
  opened_at: null,
  accepted_at: null,
  completed_at: null,
  cancelled_at: null,
  printed_at: null,
  updated_at: at(NOW - 5 * M),
  due_time: null,
  order_type: "pickup",
  payment_type: "card",
  channel_id: null,
  customer_name: "Marcus Bell",
  customer_phone: "(615) 555-0142",
  items: [
    { name: "Shrimp Po'Boy", price: "$14.00", modifiers: ["Dressed"] },
    { name: "Gumbo", price: "$6.00", modifiers: [] },
    { name: "Lemonade", price: "$3.00", modifiers: [] },
    { name: "Beignets", price: "$5.00", modifiers: [] },
  ],
  customer_total: "31.92",
  ...over,
});
const R1 = { id: "r1", crm_restaurant_id: "acct-1", name: "Willie Mae's", prep_minutes: 25, print_method: "printer", app_expected: true, has_active_printer: true };

test("the list carries the phone's last four only, the items line, a numeric total and both restaurant ids", () => {
  const row = shapeOrderRow(order("a"), R1, [], NOW);
  assert.equal(row.customer.phone_last4, "0142");
  assert.equal((row.customer as any).phone, undefined, "never the whole number in a list");
  assert.equal(row.items_line, "Shrimp Po'Boy · Gumbo · Lemonade …");
  assert.equal(row.item_count, 4);
  assert.equal(row.total, 31.92);
  assert.deepEqual(row.restaurant, { id: "r1", crm_restaurant_id: "acct-1", name: "Willie Mae's" });
  assert.deepEqual(row.destinations, ["printer", "app"]);
  assert.equal(row.prep_minutes, 25);
  assert.equal(phoneLast4("615"), null);
  assert.equal(phoneLast4(null), null);
});

test("print state: printed > failed > stuck/held/queued > expired > none, paper rows only", () => {
  const j = (over: Partial<PrintJobRow>): PrintJobRow => ({ id: "j", status: "queued", delivery: "epson", queued_at: at(NOW - M), ...over });
  assert.equal(printSummary([], NOW).state, "none");
  assert.equal(printSummary([j({ delivery: "app", status: "printed" })], NOW).state, "none", "an app row is not paper");
  assert.equal(printSummary([j({ status: "printed" }), j({ id: "k", status: "failed" })], NOW).state, "printed");
  assert.deepEqual(printSummary([j({ status: "failed", error: "Printer is out of paper (EPTR_REC_EMPTY)" })], NOW), { state: "failed", job_id: "j", failed_reason: "Printer is out of paper (EPTR_REC_EMPTY)" });
  assert.equal(printSummary([j({ status: "queued" })], NOW).state, "queued");
  assert.equal(printSummary([j({ status: "held", error: "Printer cover is open (EPTR_COVER_OPEN)" })], NOW).state, "held");
  assert.equal(printSummary([j({ status: "claimed", queued_at: at(NOW - PRINT_STUCK_MS) })], NOW).state, "stuck");
  assert.equal(printSummary([j({ status: "expired" })], NOW).state, "expired");
});

test("flags come from the tablet's own rules: unaccepted past three minutes, late past ten, overtime past the countdown", () => {
  assert.deepEqual(orderFlags(order("a", { received_at: at(NOW - 2 * M) }), 25, NOW), { unaccepted_over_3m: false, late: false, overtime: false });
  assert.deepEqual(orderFlags(order("a", { received_at: at(NOW - UNACCEPTED_FLAG_MS) }), 25, NOW), { unaccepted_over_3m: true, late: false, overtime: false });
  assert.deepEqual(orderFlags(order("a", { received_at: at(NOW - 11 * M) }), 25, NOW), { unaccepted_over_3m: true, late: true, overtime: false });
  assert.deepEqual(orderFlags(order("a", { received_at: at(NOW - 40 * M), accepted_at: at(NOW - 30 * M) }), 25, NOW), { unaccepted_over_3m: false, late: true, overtime: true });
  assert.deepEqual(orderFlags(order("a", { status: "completed", received_at: at(NOW - 40 * M), accepted_at: at(NOW - 30 * M), completed_at: at(NOW - M) }), 25, NOW), { unaccepted_over_3m: false, late: false, overtime: false });
  assert.equal(orderFlags(order("a", { received_at: at(NOW - 7 * 60 * M) }), 25, NOW).unaccepted_over_3m, false, "past the six-hour window the tablet has let go; so does this");
});

console.log("\nthe sort and the counts:");

test("the tablet's order across restaurants: unaccepted oldest first, then by least time left, then settled newest first", () => {
  const rows = [
    order("done-early", { status: "completed", received_at: at(NOW - 120 * M), accepted_at: at(NOW - 110 * M), completed_at: at(NOW - 90 * M) }),
    order("acc-15", { accepted_at: at(NOW - 10 * M) }),
    order("new-2", { received_at: at(NOW - 2 * M) }),
    order("cancelled", { status: "cancelled", received_at: at(NOW - 60 * M), cancelled_at: at(NOW - 50 * M) }),
    order("acc-over", { accepted_at: at(NOW - 30 * M) }),
    order("new-9", { received_at: at(NOW - 9 * M) }),
    order("done-late", { status: "completed", received_at: at(NOW - 40 * M), accepted_at: at(NOW - 35 * M), completed_at: at(NOW - 20 * M) }),
  ].map((o) => shapeOrderRow(o, R1, [], NOW));
  assert.deepEqual(sortOrderRows(rows, NOW).map((r) => r.order_id), ["new-9", "new-2", "acc-over", "acc-15", "done-late", "cancelled", "done-early"]);
  // For one restaurant the open part is exactly kitchenSort.
  const open = rows.filter((r) => r.status !== "completed" && r.status !== "cancelled");
  assert.deepEqual(sortOrderRows(open, NOW).map((r) => r.order_id), kitchenSort(open as any, 25, NOW).map((r: any) => r.order_id));
  // A restaurant with a longer target sorts by ITS remaining time.
  const slow = shapeOrderRow(order("slow", { restaurant_id: "r2", accepted_at: at(NOW - 20 * M) }), { ...R1, id: "r2", prep_minutes: 60 }, [], NOW); // 40 left
  const fast = shapeOrderRow(order("fast", { accepted_at: at(NOW - 20 * M) }), R1, [], NOW); // 5 left
  assert.deepEqual(sortOrderRows([slow, fast], NOW).map((r) => r.order_id), ["fast", "slow"]);
});

test("counts: unaccepted, in kitchen, completed, cancelled, unprinted (meant to print and no ticket yet), test", () => {
  const printed: PrintJobRow[] = [{ id: "j", status: "printed", delivery: "epson" }];
  const rows = [
    shapeOrderRow(order("n"), R1, [], NOW),
    shapeOrderRow(order("a", { accepted_at: at(NOW - M) }), R1, printed, NOW),
    shapeOrderRow(order("c", { status: "completed", completed_at: at(NOW) }), R1, printed, NOW),
    shapeOrderRow(order("x", { status: "cancelled", cancelled_at: at(NOW) }), R1, [], NOW),
    shapeOrderRow(order("t", { source: "test" }), R1, [], NOW),
  ];
  assert.deepEqual(orderCounts(rows), { total: 5, unaccepted: 2, in_kitchen: 1, completed: 1, cancelled: 1, unprinted: 2, test: 1 });
});

test("`since` keeps rows changed after it, and any row that cannot say", () => {
  const rows = [
    { updated_at: at(NOW - 10 * M), id: "old" },
    { updated_at: at(NOW - M), id: "new" },
    { updated_at: null, id: "unknown" },
  ];
  assert.deepEqual(changedSince(rows, at(NOW - 5 * M)).map((r) => r.id), ["new", "unknown"]);
  assert.equal(changedSince(rows, null).length, 3);
  assert.equal(changedSince(rows, "junk").length, 3);
});

console.log("\nthe detail:");

test("the timeline is the order's life in order, print attempts named by device and outcome", () => {
  const o = order("a", { opened_at: at(NOW - 4 * M), accepted_at: at(NOW - 3 * M), completed_at: at(NOW - M) });
  const jobs: PrintJobRow[] = [
    { id: "j1", status: "failed", delivery: "epson", queued_at: at(NOW - 5 * M), finished_at: at(NOW - 4.5 * M), error: "Printer offline (EX_TIMEOUT)", device_name: "Kitchen" },
    { id: "j2", status: "printed", delivery: "epson", queued_at: at(NOW - 4.4 * M), finished_at: at(NOW - 4.2 * M), device_name: "Kitchen", queued_by: "reprint:crm:nick" },
    { id: "j3", status: "printed", delivery: "app", sent_at: at(NOW - 4.9 * M), delivered_count: 1 },
  ];
  const t = orderTimeline(o, jobs);
  assert.deepEqual(t.map((e) => e.event), ["received", "print_attempt", "printed", "opened", "accepted", "completed"]);
  assert.equal(t[1].detail, "failed on Kitchen - Printer offline (EX_TIMEOUT)");
  assert.equal(t[2].detail, "printed on Kitchen");
  assert.deepEqual(appDelivery(jobs), { pushed: true, at: at(NOW - 4.9 * M), devices_reached: 1, error: null });
  assert.equal(appDelivery([]), null);
  assert.deepEqual(appDelivery([{ id: "j", status: "failed", delivery: "app", send_error: "no device has notifications enabled for this restaurant", delivered_count: 0 }]), {
    pushed: false,
    at: null,
    devices_reached: 0,
    error: "no device has notifications enabled for this restaurant",
  });
});

console.log("\nthe routes:");

test("the list and the detail never read raw_html or raw_payload; the detail is where the full phone lives", () => {
  const data = src("lib/crm-orders-data.ts");
  const selects = [...data.matchAll(/"([^"]*received_at[^"]*|[^"]*customer_address[^"]*)"/g)].map((m) => m[1]);
  assert.ok(selects.length >= 2, "both select strings found");
  for (const sel of selects) assert.doesNotMatch(sel, /raw_html|raw_payload/, "a select must never read the raw source");
  assert.match(data, /customer_address, notes, external_id/);
  const list = src("app/api/crm/orders/route.ts");
  assert.match(list, /findRestaurantByRef<\{ id: string \}>\(ref, "id"\)/, "either id");
  assert.match(list, /if \(!includeTest\) query = query\.neq\("source", "test"\)/, "tests hidden by default");
  assert.match(list, /\.gte\("received_at", window\.start\)[\s\S]*?\.lt\("received_at", window\.end\)/);
  assert.match(list, /orders: changedSince\(sorted, since\)/);
  assert.match(list, /counts: orderCounts\(sorted\)/, "counts are the whole day, whatever since says");
  const detail = src("app/api/crm/orders/[id]/route.ts");
  assert.match(detail, /customer: \{ name: row\.customer_name \?\? null, phone: row\.customer_phone \?\? null, address: row\.customer_address \?\? null \}/);
  assert.match(detail, /timeline: orderTimeline\(row, jobs\)/);
  assert.match(detail, /app_delivery: appDelivery\(jobs\)/);
  for (const p of ["app/api/crm/orders/route.ts", "app/api/crm/orders/[id]/route.ts", "app/api/crm/orders/[id]/actions/route.ts"]) {
    assert.match(src(p), /authorizeCrmWrite\(req\)/, p);
  }
});

test("actions reuse the two primitives that already existed, name the actor, and refuse a settled order", () => {
  const a = src("app/api/crm/orders/[id]/actions/route.ts");
  assert.match(a, /queueOrderToPrinters\(order\.id, order\.restaurant_id, \{\s*queuedBy: reprintBy\(`crm:\$\{actor\}`\)/);
  assert.match(a, /notifyRestaurant\(order\.restaurant_id, \{/);
  assert.match(a, /appDeliveryOutcome\(push, now\)/);
  assert.match(a, /\.eq\("delivery", "app"\)/, "the outcome lands on the order's one app row");
  assert.match(a, /order\.status === "cancelled" \|\| order\.status === "completed"[\s\S]*?status: 409/);
  assert.match(a, /code: "app_not_expected"/);
  assert.ok(isOrderAction("reprint") && isOrderAction("resend_app") && !isOrderAction("cancel"));
  assert.doesNotMatch(a, /\.from\("orders"\)\s*\.update|\.delete\(/, "no new way to touch an order");
});

test("accounting/orders takes either id now, and the contract documents both endpoints", () => {
  const acc = src("app/api/crm/accounting/orders/route.ts");
  assert.match(acc, /findRestaurantByRef<\{ id: string \}>\(ref, "id"\)/);
  assert.doesNotMatch(acc, /query\.eq\("restaurant_id", q\.get/);
  const doc = src("docs/crm-bridge-contract.md");
  assert.match(doc, /GET \| `\/api\/crm\/orders`/);
  assert.match(doc, /GET \| `\/api\/crm\/orders\/:id`/);
  assert.match(doc, /POST \| `\/api\/crm\/orders\/:id\/actions`/);
  assert.match(doc, /GET \| `\/api\/crm\/accounting\/orders`/);
  assert.match(doc, /phone_last4/);
});

console.log(`\n${passed} assertions passed.`);
