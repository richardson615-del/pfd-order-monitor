/**
 * The restaurant's weekly statements on its tablet (migration 051).
 *
 * Worth asserting: a CRM push is checked whole (one bad week fails it);
 * only https links on the CRM's host are accepted (the app opens them for
 * the restaurant); the Money page's summary never invents money (a week
 * with no amount is a refused push, not $0); and, by reading the routes,
 * that the tablet never writes statements and the CRM never writes without
 * the key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cents, isStatementUrl, moneySummary, parseStatementsPush, statusLabel, weekLabel, type StatementView } from "@/lib/statements";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
}
const src = (p: string) => readFileSync(p, "utf8");
const CRM = ["https://crm.pfdworks.com"];
const errorOf = (d: ReturnType<typeof parseStatementsPush>): string => ("error" in d ? d.error : "");

const week = {
  period_start: "2026-10-13",
  period_end: "2026-10-19",
  statement_no: "WM-20261013",
  payment_status: "paid",
  paid_at: "2026-10-28T15:00:00Z",
  payment_date: "2026-10-28",
  payment_ref: "ACH 1234",
  order_count: 132,
  amount_due_cents: 412_355,
  view_url: "https://crm.pfdworks.com/api/statements/view/abc",
  pdf_url: "https://crm.pfdworks.com/api/statements/view/abc?format=pdf",
  generated_at: "2026-10-21T12:00:00Z",
  payload: { lines: [{ label: "Food", amount: "$5,000.00" }] },
};

console.log("statements push");

test("a good push parses whole, with the links kept", () => {
  const r = parseStatementsPush({ statements: [week, { ...week, period_start: "2026-10-06", period_end: "2026-10-12", payment_status: "pending", paid_at: null, view_url: null, pdf_url: null }] }, CRM);
  assert.ok(r.ok);
  if ("error" in r) return;
  assert.equal(r.statements.length, 2);
  assert.equal(r.statements[0]!.amount_due_cents, 412_355);
  assert.equal(r.statements[0]!.view_url, week.view_url);
  assert.equal(r.statements[1]!.view_url, null);
  assert.equal(r.statements[0]!.paid_at, "2026-10-28T15:00:00.000Z");
});

test("one bad week fails the whole push", () => {
  const bad = parseStatementsPush({ statements: [week, { ...week, period_start: "2026-10-06", period_end: "2026-10-12", amount_due_cents: "4123.55" }] }, CRM);
  assert.match(errorOf(bad), /statement 1: amount_due_cents/);
});

test("a missing amount is refused, never read as $0", () => {
  const { amount_due_cents: _a, ...noAmount } = week;
  const r = parseStatementsPush({ statements: [noAmount] }, CRM);
  assert.ok(!r.ok);
});

test("the same week twice is refused", () => {
  const r = parseStatementsPush({ statements: [week, { ...week }] }, CRM);
  assert.ok(!r.ok);
  assert.match(errorOf(r), /appears twice/);
});

test("an unknown payment status, a backwards week and a bad date are refused", () => {
  assert.ok(!parseStatementsPush({ statements: [{ ...week, payment_status: "maybe" }] }, CRM).ok);
  assert.ok(!parseStatementsPush({ statements: [{ ...week, period_end: "2026-10-01" }] }, CRM).ok);
  assert.ok(!parseStatementsPush({ statements: [{ ...week, period_start: "10/13/2026" }] }, CRM).ok);
  assert.ok(!parseStatementsPush({ statements: [{ ...week, paid_at: "yesterday" }] }, CRM).ok);
});

test("only https links on the CRM's host are accepted", () => {
  assert.ok(isStatementUrl("https://crm.pfdworks.com/api/statements/view/x", CRM));
  assert.ok(!isStatementUrl("http://crm.pfdworks.com/api/statements/view/x", CRM));
  assert.ok(!isStatementUrl("https://evil.example.com/crm.pfdworks.com/x", CRM));
  assert.ok(!isStatementUrl("javascript:alert(1)", CRM));
  const r = parseStatementsPush({ statements: [{ ...week, view_url: "https://evil.example.com/x" }] }, CRM);
  assert.ok(!r.ok);
  assert.match(errorOf(r), /view_url/);
  // An empty string is "no link", not a bad link.
  const r2 = parseStatementsPush({ statements: [{ ...week, view_url: "", pdf_url: "" }] }, CRM);
  assert.ok(r2.ok);
  if (!("error" in r2)) assert.equal(r2.statements[0]!.view_url, null);
});

test("a push with no statements is fine (nothing to write)", () => {
  const r = parseStatementsPush({ statements: [] }, CRM);
  assert.ok(r.ok);
  if (!("error" in r)) assert.equal(r.statements.length, 0);
  assert.ok(!parseStatementsPush({}, CRM).ok);
});

console.log("money page");

const rows: StatementView[] = [
  { period_start: "2026-10-13", period_end: "2026-10-19", statement_no: "A", payment_status: "pending", paid_at: null, payment_date: "2026-10-28", order_count: 10, amount_due_cents: 100_00, view_url: null, pdf_url: null },
  { period_start: "2026-10-06", period_end: "2026-10-12", statement_no: "B", payment_status: "paid", paid_at: "2026-10-21T00:00:00Z", payment_date: "2026-10-21", order_count: 12, amount_due_cents: 250_00, view_url: null, pdf_url: null },
  { period_start: "2026-09-29", period_end: "2026-10-05", statement_no: "C", payment_status: "paid", paid_at: "2026-10-14T00:00:00Z", payment_date: "2026-10-14", order_count: 9, amount_due_cents: 90_00, view_url: null, pdf_url: null },
  { period_start: "2026-09-22", period_end: "2026-09-28", statement_no: "D", payment_status: "skipped", paid_at: null, payment_date: null, order_count: 0, amount_due_cents: 0, view_url: null, pdf_url: null },
  { period_start: "2026-09-15", period_end: "2026-09-21", statement_no: "E", payment_status: "none", paid_at: null, payment_date: null, order_count: 3, amount_due_cents: -5_00, view_url: null, pdf_url: null },
];

test("the summary adds only unpaid weeks with money coming, and names the newest paid week", () => {
  const s = moneySummary(rows);
  assert.equal(s.owedCents, 100_00);
  assert.equal(s.owedWeeks, 1);
  assert.equal(s.lastPaid?.statement_no, "B");
  assert.equal(s.weeks, 5);
});

test("labels", () => {
  assert.equal(statusLabel(rows[0]!).label, "Paying");
  assert.equal(statusLabel(rows[1]!).label, "Paid");
  assert.equal(statusLabel(rows[3]!).label, "Not paid this week");
  assert.equal(statusLabel({ ...rows[0]!, payment_status: "held" }).tone, "attention");
  assert.equal(weekLabel("2026-10-13", "2026-10-19"), "Oct 13 - Oct 19");
  assert.equal(cents(412_355), "$4,123.55");
  assert.equal(cents(-500), "-$5.00");
});

console.log("routes");

test("the tablet reads through the session client; only the CRM writes, with the key", () => {
  const read = src("app/api/dashboard/statements/route.ts");
  assert.match(read, /supabaseServer\(\)/);
  assert.doesNotMatch(read, /supabaseAdmin/);
  assert.doesNotMatch(read, /\.(upsert|insert|update|delete)\(/);
  const write = src("app/api/crm/restaurants/[id]/statements/route.ts");
  assert.match(write, /authorizeCrmWrite\(req\)/);
  assert.match(write, /findRestaurantByRef/);
  assert.match(write, /onConflict: "restaurant_id,period_start"/);
  const migration = src("db/migrations/051_restaurant_statements.sql");
  assert.match(migration, /enable row level security/);
  assert.match(migration, /for select using \(is_admin\(\) or belongs_to_restaurant\(restaurant_id\)\)/);
  assert.doesNotMatch(migration, /for (insert|update|delete)/);
});

test("the Money tab opens statements on the CRM's link and computes no money of its own", () => {
  const tab = src("components/MoneyTab.tsx");
  assert.match(tab, /rel="noopener noreferrer"/);
  assert.doesNotMatch(tab, /commission|rate|fee/i);
  assert.match(src("components/OrderDashboard.tsx"), /tab === "money" && <MoneyTab \/>/);
});

console.log(`\n${passed} passed`);
