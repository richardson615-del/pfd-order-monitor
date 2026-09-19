/**
 * `truncated` must reflect whether more data exists, never whether the
 * platform silently capped a single large read.
 *
 * Confirmed live, 2026-09-19: a request for up to 2000 rows returned
 * exactly 1000 with no error -- Supabase/PostgREST silently capping a
 * `.range()` read below the requested `limit`. The route's first
 * pagination version computed `truncated = rows.length === limit`, which
 * is `false` whenever that happens (1000 !== 2000), so a caller looping
 * on `truncated` (prs-crm's `fetchAccountingOrders`) stopped after page 1
 * believing it had everything. The real total for that date range was
 * 1149, not 1000 -- 149 real orders, including 28 of one restaurant's
 * own orders, were silently missing from every downstream payout
 * computation until this was caught.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const route = readFileSync("app/api/crm/accounting/orders/route.ts", "utf8");

console.log("accounting/orders pagination truncation:");

test("truncated is NOT computed as rows.length === limit -- that's the bug this file exists to prevent", () => {
  assert.doesNotMatch(route, /truncated:\s*rows\.length\s*===\s*limit/);
});

test("truncated is computed from whether more than `limit` rows were actually fetched", () => {
  assert.match(route, /const truncated = data\.length > limit/);
});

test("the route asks for one row PAST `limit` (limit + 1) to detect a next page, then drops it from the response", () => {
  assert.match(route, /const targetCount = limit \+ 1/);
  assert.match(route, /if \(truncated\) data\.length = limit/);
});

test("no single Supabase read is ever asked for more than a safe chunk size, regardless of how large `limit` is", () => {
  // The platform's own per-request row cap is undocumented and could
  // change -- this route must never bet on a fixed large `.range()`
  // request succeeding in full. It also must never ask Supabase for
  // more than its own safe chunk constant per call.
  assert.match(route, /const SUPABASE_SAFE_CHUNK = 500/);
  assert.match(route, /Math\.min\(SUPABASE_SAFE_CHUNK, targetCount - data\.length\)/);
});

test("a short chunk (fewer rows than asked for) is treated as real end-of-data, not a signal to keep looping forever", () => {
  assert.match(route, /if \(!chunk \|\| chunk\.length < chunkLimit\) break/);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
