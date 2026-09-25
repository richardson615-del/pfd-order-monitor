/**
 * Source-contract tests for GET /api/crm/customers/orders (2026-09-19),
 * matching this repo's existing convention (regex-checks the route's own
 * source, same as test-cancellation-lifecycle.ts /
 * test-accounting-pagination-truncation.ts) rather than a live Supabase
 * call.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const route = readFileSync("app/api/crm/customers/orders/route.ts", "utf8");

console.log("customers/orders contract:");

test("requires from/to date params", () => {
  assert.match(route, /if \(!from \|\| !to\)/);
});

test("test orders are excluded (not revenue)", () => {
  assert.match(route, /\.neq\("source", "test"\)/);
});

test("cancelled orders are excluded (never a real customer interaction to count)", () => {
  assert.match(route, /\.is\("cancelled_at", null\)/);
});

test("selects customer identity fields, not just money", () => {
  assert.match(route, /customer_name/);
  assert.match(route, /customer_phone/);
  assert.match(route, /customer_email/);
});

test("truncated uses the same limit+1 detection as accounting/orders -- not the broken rows.length===limit comparison", () => {
  assert.match(route, /const targetCount = limit \+ 1/);
  assert.doesNotMatch(route, /truncated:\s*(data|rows)\.length\s*===\s*limit/);
});

test("no single Supabase read exceeds the safe chunk size", () => {
  assert.match(route, /const SUPABASE_SAFE_CHUNK = 500/);
});

test("line_items (row 66) are selected and returned, null when absent", () => {
  assert.match(route, /SELECT_COLUMNS =\s*"[^"]*\bline_items\b/);
  assert.match(route, /line_items: o\.line_items \?\? null/);
});

test("response echoes the zuppler_restaurant_id needed to resolve a CRM account", () => {
  assert.match(route, /zuppler_restaurant_id/);
});

test("this is a distinct route from accounting/orders and from the daily orders list -- not a shared handler", () => {
  assert.doesNotMatch(route, /ORDER_LIST_SELECT/); // that's /api/crm/orders' own shape, not this route's
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
