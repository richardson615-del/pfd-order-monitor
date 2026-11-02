/**
 * GL1 (go-live readiness test), bridge side: the harness's pure parts.
 * Brief: docs/briefs/2026-11-01-go-live-readiness-test.md.
 *
 * The harness itself needs a deployment and the bridge dev database
 * (scripts/golive/selftest.ts); what is pinned here is what decides whether
 * it may run at all, which rows are synthetic, and how the virtual Epson
 * reads what the bridge sends it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkBaseUrl,
  checkDatabaseLooksDev,
  checkSameDatabase,
  diffCounts,
  EPSON_SUCCESS_RESPONSE,
  eposJobCount,
  eposOrderNumber,
  eposTextLines,
  getRequestBody,
  glCrmId,
  GL_DEVICE_REF_PREFIX,
  GL_NAME_PREFIX,
  isEmptyEpsonReply,
  isGlName,
  overall,
  parseManifest,
  pct,
  renderSelftestReport,
  setResponseBody,
  stats,
  syntheticRestaurants,
  USERNAME_DOMAIN_SUFFIX,
} from "./golive/lib";
import { buildTicket, toEposPrintXml } from "../lib/ticket";

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

console.log("GL1 synthetic market");

test("100 restaurants by default, deterministic CRM ids the CRM seed can reproduce", () => {
  const m = syntheticRestaurants();
  assert.equal(m.length, 100);
  assert.equal(m[0].crm_restaurant_id, "91000000-0000-4000-8000-000000000001");
  assert.equal(m[99].crm_restaurant_id, "91000000-0000-4000-8000-000000000100");
  assert.equal(m[0].crm_restaurant_id, glCrmId(1));
  assert.deepEqual(syntheticRestaurants(), m, "same input, same market");
});

test("every id, name, Zuppler id and device ref is unique and marked synthetic", () => {
  const m = syntheticRestaurants(250);
  for (const k of ["crm_restaurant_id", "name", "zuppler_id", "device_ref"] as const) {
    assert.equal(new Set(m.map((r) => r[k])).size, m.length, k);
  }
  assert.ok(m.every((r) => isGlName(r.name) && r.device_ref.startsWith(GL_DEVICE_REF_PREFIX)));
  assert.ok(m.every((r) => /^[0-9a-f-]{36}$/.test(r.crm_restaurant_id)));
  assert.ok(m.every((r) => r.timezone === "America/Chicago"), "Springfield / White House are Central time");
});

test("count outside 1-999 is refused", () => {
  assert.throws(() => syntheticRestaurants(0));
  assert.throws(() => syntheticRestaurants(1000));
  assert.throws(() => glCrmId(0));
});

test("a manifest keeps the CRM's ids and names, always prefixed [GL]", () => {
  const m = syntheticRestaurants(0, parseManifest([
    { crm_restaurant_id: "AAAAAAAA-1111-4111-8111-111111111111", name: "Mama Rosa's (synthetic)", zuppler_id: "123" },
    { crm_restaurant_id: "bbbbbbbb-2222-4222-8222-222222222222", name: "[GL] Already prefixed" },
  ]));
  assert.equal(m[0].crm_restaurant_id, "aaaaaaaa-1111-4111-8111-111111111111");
  assert.equal(m[0].name, `${GL_NAME_PREFIX}Mama Rosa's (synthetic)`);
  assert.equal(m[0].zuppler_id, "123");
  assert.equal(m[1].name, "[GL] Already prefixed");
  assert.equal(m[1].device_ref, "GL-SIM-002");
});

test("manifest validation: uuid, name, numeric unique Zuppler id, no duplicates", () => {
  assert.throws(() => parseManifest([]));
  assert.throws(() => parseManifest([{ crm_restaurant_id: "nope", name: "x" }]));
  assert.throws(() => parseManifest([{ crm_restaurant_id: glCrmId(1), name: "" }]));
  assert.throws(() => parseManifest([{ crm_restaurant_id: glCrmId(1), name: "a", zuppler_id: "12a" }]));
  assert.throws(() => parseManifest([{ crm_restaurant_id: glCrmId(1), name: "a" }, { crm_restaurant_id: glCrmId(1), name: "b" }]));
  assert.throws(() => parseManifest([{ crm_restaurant_id: glCrmId(1), name: "a", zuppler_id: "5" }, { crm_restaurant_id: glCrmId(2), name: "b", zuppler_id: "5" }]));
  assert.equal(parseManifest({ restaurants: [{ crm_restaurant_id: glCrmId(3), name: "c" }] }).length, 1);
});

test("the login email suffix is the tablet login domain", () => {
  assert.equal(USERNAME_DOMAIN_SUFFIX, "@tablet.pfdworks.com");
});

console.log("GL1 guards: nothing touches production");

test("the production hostname is refused, with or without a path", () => {
  assert.match(checkBaseUrl("https://pfd-order-monitor.vercel.app")!, /production/);
  assert.match(checkBaseUrl("https://pfd-order-monitor.vercel.app/api")!, /production/);
  assert.match(checkBaseUrl("https://orders.example.com", ["orders.example.com"])!, /production/);
});

test("a preview URL passes; missing, non-URL and plain http are refused", () => {
  assert.equal(checkBaseUrl("https://pfd-order-monitor-git-gl-x-team.vercel.app"), null);
  assert.equal(checkBaseUrl("http://localhost:3000"), null);
  assert.ok(checkBaseUrl(undefined));
  assert.ok(checkBaseUrl("not a url"));
  assert.ok(checkBaseUrl("http://example.com"));
});

test("a database with real orders in the last week is refused", () => {
  assert.match(checkDatabaseLooksDev({ realRestaurants: 3, realOrders7d: 1 })!, /real/);
});

test("a production-sized roster is refused; an empty or small dev one passes", () => {
  assert.ok(checkDatabaseLooksDev({ realRestaurants: 150, realOrders7d: 0 }));
  assert.equal(checkDatabaseLooksDev({ realRestaurants: 0, realOrders7d: 0 }), null);
  assert.equal(checkDatabaseLooksDev({ realRestaurants: 20, realOrders7d: 0 }), null);
});

test("deployment and database must hold exactly the same restaurants", () => {
  assert.equal(checkSameDatabase([], []), null);
  assert.equal(checkSameDatabase(["A", "b"], ["a", "B"]), null);
  assert.match(checkSameDatabase(["x"], [])!, /different databases/, "preview on another DB (e.g. production)");
  assert.match(checkSameDatabase([], ["y"])!, /different databases/);
});

test("every GL script runs the guards before it writes", () => {
  assert.match(src("scripts/golive/seed.ts"), /await preflight\(db\);\s*const r = await seed/);
  assert.match(src("scripts/golive/simulate.ts"), /await preflight\(db\);/);
  assert.match(src("scripts/golive/teardown.ts"), /await guardDatabase\(db\);\s*const before/);
  assert.match(src("scripts/golive/selftest.ts"), /const pre = await preflight\(db\);/);
  assert.match(src("scripts/golive/seed.ts"), /await canary\(db, first\)/, "first write is checked against the DB before the rest");
});

test("the harness never reads production env names and keeps its own env file out of git", () => {
  for (const f of ["db.ts", "http.ts", "seed.ts", "simulate.ts", "teardown.ts", "selftest.ts", "preflight.ts"]) {
    const s = src(`scripts/golive/${f}`);
    assert.doesNotMatch(s, /MIGRATION_DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY|process\.env\.CRM_WRITE_KEY/, f);
  }
  assert.match(src(".gitignore"), /^\.env\*$/m);
});

test("teardown deletes set-null children explicitly and runs in one transaction", () => {
  const s = src("scripts/golive/db.ts");
  assert.match(s, /await db\.query\("begin"\)/);
  assert.match(s, /await db\.query\("rollback"\)/);
  assert.match(s, /deleteTree\(db, "public\.restaurants", "id", ids, tally\)/);
});

console.log("GL1 virtual Epson");

const order = {
  order_number: "TEST-ABC123",
  source: "test",
  ticket_restaurant_name: "[GL] Test Kitchen 001",
  order_type: "pickup",
  due_time: null,
  customer_name: "Premium test order",
  items: [{ name: "2x Test item", price: "$0.00", modifiers: ["This is a test"] }],
  items_total: 0,
  customer_total: 0,
  notes: "Fish & chips <no salt>",
  received_at: new Date().toISOString(),
};
const ticketXml =
  `<?xml version="1.0" encoding="utf-8"?>\n<PrintRequestInfo Version="1.00"><ePOSPrint><Parameter><devid>local_printer</devid></Parameter><PrintData>` +
  toEposPrintXml(buildTicket(order as any, 48, { text: "Thanks", url: null }) as any, 48) +
  `</PrintData></ePOSPrint></PrintRequestInfo>`;

test("reads the order number off a ticket the bridge renders", () => {
  assert.equal(eposOrderNumber(ticketXml), "TEST-ABC123");
  assert.equal(eposJobCount(ticketXml), 1);
});

test("text lines are decoded the way the printer would print them", () => {
  const lines = eposTextLines(ticketXml);
  assert.ok(lines.some((l) => l.includes("Fish & chips <no salt>")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("TEST ITEM")));
});

test("an empty 200 is 'nothing to print'", () => {
  assert.equal(isEmptyEpsonReply(""), true);
  assert.equal(isEmptyEpsonReply(ticketXml), false);
  assert.equal(eposOrderNumber(""), null);
});

test("the poll and the result are the forms the route parses", () => {
  const get = new URLSearchParams(getRequestBody("PFD-AAAA-BBBB-CCCC"));
  assert.equal(get.get("ConnectionType"), "GetRequest");
  assert.equal(get.get("ID"), "PFD-AAAA-BBBB-CCCC");
  const set = new URLSearchParams(setResponseBody("PFD-AAAA-BBBB-CCCC"));
  assert.equal(set.get("ConnectionType"), "SetResponse");
  const file = set.get("ResponseFile")!;
  // The route's own tests of a result (app/api/print/epson/route.ts handleSetResponse):
  assert.match(file, /success="true"/i);
  assert.equal(file.match(/<printjobid>([^<]*)<\/printjobid>/i)?.[1]?.trim(), "", "1.00: no printjobid, oldest claim wins");
  assert.equal(file.match(/code="([^"]*)"/i)?.[1], "");
  assert.ok(file === EPSON_SUCCESS_RESPONSE);
});

console.log("GL1 numbers and report");

test("percentiles: nearest rank, empty is null", () => {
  assert.equal(pct([], 50), null);
  assert.equal(pct([5], 99), 5);
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(pct(v, 50), 50);
  assert.equal(pct(v, 95), 95);
  assert.equal(pct(v, 99), 99);
  assert.deepEqual(stats([3, 1, 2, NaN]), { n: 3, p50: 2, p95: 3, p99: 3, max: 3 });
});

test("count diff lists only tables that changed, including new and vanished ones", () => {
  assert.deepEqual(diffCounts({ a: 1, b: 2 }, { a: 1, b: 2 }), []);
  assert.deepEqual(diffCounts({ a: 1, b: 2 }, { a: 1, b: 3, c: 1 }), [
    { table: "b", before: 2, after: 3 },
    { table: "c", before: 0, after: 1 },
  ]);
});

test("overall verdict: any FAIL fails, else any BLOCKED blocks", () => {
  const c = (verdict: any) => ({ id: "x", name: "x", verdict, evidence: "" });
  assert.equal(overall([c("PASS"), c("PASS")]), "PASS");
  assert.equal(overall([c("PASS"), c("BLOCKED")]), "BLOCKED");
  assert.equal(overall([c("BLOCKED"), c("FAIL")]), "FAIL");
});

test("the report names the brief, every check with its evidence, and both latencies", () => {
  const md = renderSelftestReport({
    startedAt: "2026-11-02T18:00:00Z",
    finishedAt: "2026-11-02T18:05:00Z",
    baseUrl: "https://x.vercel.app",
    commit: null,
    restaurants: 100,
    checks: [{ id: "B1", name: "Preflight", verdict: "PASS", evidence: "a | b" }],
    printLatency: stats([1000, 2000]),
    tabletLatency: stats([]),
    notes: [],
  });
  assert.match(md, /^# GL1 bridge selftest — PASS/);
  assert.match(md, /2026-11-01-go-live-readiness-test\.md/);
  assert.match(md, /\| B1 \| Preflight \| \*\*PASS\*\* \| a \\\| b \|/);
  assert.match(md, /Commit: Data missing/);
  assert.match(md, /virtual Epson \| 2 \| 1\.0 s \| 2\.0 s/);
  assert.match(md, /virtual tablet \| 0 \| — \|/);
});

console.log(`\n${passed} passed`);
