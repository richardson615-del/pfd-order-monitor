/**
 * Linking an account's Zuppler listings to its restaurant here, from the CRM.
 *
 * The decisions worth pinning: a typo is refused rather than stored, an id
 * another kitchen owns refuses the WHOLE request, the primary column only
 * fills when empty (accounting joins on it), and the whole thing is
 * idempotent - a sync sent twice changes nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planZupplerMapping } from "@/lib/zuppler-mapping";

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

const LARRYS = "r-larrys";
const larrys = (over: Partial<Parameters<typeof planZupplerMapping>[0]> = {}) =>
  planZupplerMapping({
    restaurantId: LARRYS,
    currentPrimary: null,
    requested: [
      { zuppler_restaurant_id: "29924", label: "Larry's" },
      { zuppler_restaurant_id: "32712", label: "Larry's (Pick Up)" },
      { zuppler_restaurant_id: "33247", label: "Larry's Restaurant Catering" },
    ],
    existing: [],
    ...over,
  });

console.log("what gets written:");

test("every listing becomes a row, and the first one becomes the primary", () => {
  const out = larrys();
  assert.ok("plan" in out);
  assert.deepEqual(
    out.plan.upserts.map((u) => u.zuppler_restaurant_id),
    ["29924", "32712", "33247"]
  );
  assert.ok(out.plan.upserts.every((u) => u.restaurant_id === LARRYS));
  assert.equal(out.plan.setPrimary, "29924");
});

test("a primary somebody already set is not overwritten by a sync", () => {
  // Accounting joins on restaurants.zuppler_restaurant_id. A sync that
  // re-pointed it would move a restaurant's history to a different account.
  const out = larrys({ currentPrimary: "29924" });
  assert.ok("plan" in out);
  assert.equal(out.plan.setPrimary, null);
});

test("sending the same list again is a no-op in effect", () => {
  // The rows already exist for THIS restaurant: that is not a conflict.
  const out = larrys({
    currentPrimary: "29924",
    existing: [
      { zuppler_restaurant_id: "29924", restaurant_id: LARRYS, restaurant_name: "Larry's Restaurant" },
      { zuppler_restaurant_id: "32712", restaurant_id: LARRYS, restaurant_name: "Larry's Restaurant" },
    ],
  });
  assert.ok("plan" in out);
  assert.equal(out.plan.upserts.length, 3);
  assert.equal(out.plan.setPrimary, null);
});

test("duplicates in the request collapse; labels are trimmed and capped", () => {
  const out = planZupplerMapping({
    restaurantId: LARRYS,
    currentPrimary: null,
    requested: [
      { zuppler_restaurant_id: " 29924 ", label: "  main  " },
      { zuppler_restaurant_id: "29924", label: "again" },
      { zuppler_restaurant_id: "32712", label: "x".repeat(500) },
    ],
    existing: [],
  });
  assert.ok("plan" in out);
  assert.equal(out.plan.upserts.length, 2);
  assert.equal(out.plan.upserts[0].label, "main");
  assert.equal(out.plan.upserts[1].label!.length, 120);
});

console.log("\nwhat gets refused:");

test("a non-numeric id is a 400, not a row that drops orders later", () => {
  const out = larrys({ requested: [{ zuppler_restaurant_id: "2992a" }] });
  assert.ok("error" in out);
  assert.equal(out.status, 400);
  assert.match(out.error, /digits only/);
});

test("an empty list is a 400", () => {
  const out = larrys({ requested: [] });
  assert.ok("error" in out && out.status === 400);
});

test("an id another kitchen owns refuses the whole request and names them", () => {
  // Refusing everything rather than writing the two that were fine: a
  // half-applied mapping is the state that produced silent drops.
  const out = larrys({
    existing: [
      { zuppler_restaurant_id: "32712", restaurant_id: "r-other", restaurant_name: "Larry's Pizza" },
    ],
  });
  assert.ok("error" in out);
  assert.equal(out.status, 409);
  assert.match(out.error, /32712 is already mapped to "Larry's Pizza"/);
});

console.log("\nthe endpoint:");

test("POST /api/crm/restaurants is bearer-gated, additive, and consults both tables", () => {
  const route = src("app/api/crm/restaurants/route.ts");
  assert.match(route, /export async function POST/);
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /authorizeCrmWrite\(req\)/);
  assert.match(post, /resolveOrCreateRestaurant\(/, "find-or-create, like devices");
  assert.match(post, /from\("restaurant_zuppler_ids"\)[\s\S]*?\.in\("zuppler_restaurant_id", wanted\)/);
  assert.match(post, /from\("restaurants"\)[\s\S]*?\.in\("zuppler_restaurant_id", wanted\)/, "the legacy column can own an id too");
  assert.match(post, /onConflict: "zuppler_restaurant_id"/);
  assert.doesNotMatch(post, /\.delete\(\)/, "a sync never unmaps");
});

test("the roster reports every listing a restaurant owns", () => {
  // The row is shaped in lib/crm-roster.ts since D1 gave GET /:id the same shape.
  const route = src("lib/crm-roster.ts");
  assert.match(route, /zuppler_ids: zupplerIdsFor\(r\.zuppler_restaurant_id/);
  assert.match(src("docs/crm-bridge-contract.md"), /POST \| `\/api\/crm\/restaurants` \|/);
});

test("ingest still honours both tables, so a synced id routes on arrival", () => {
  const ingest = src("lib/zuppler-ingest.ts");
  assert.match(ingest, /from\("restaurant_zuppler_ids"\)/);
  assert.match(ingest, /\.eq\("zuppler_restaurant_id", zupplerId\)/);
});

console.log(`\n${passed} assertions passed.`);
