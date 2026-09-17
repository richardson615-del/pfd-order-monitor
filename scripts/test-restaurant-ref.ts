/**
 * A restaurant has two ids and the CRM sends the other one.
 *
 * 2026-09-17 (Nick, from the production roster): Twisted Fork is
 * 371eaaa3-… here and 9ae1f031-… in the CRM; Willie Mae's 940bf644-… and
 * 45bef1a1-…. The tablet routes looked the CRM's id up in `restaurants.id`
 * and told the CRM "restaurant not found" for every restaurant - so no
 * tablet could be assigned, linked or bootstrapped. Every CRM-facing
 * route now resolves a reference against both columns and works with the
 * row's own id from there.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REF_RE, UUID_RE, restaurantRefFilter } from "../lib/restaurant-ref";

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
const BRIDGE = "371eaaa3-1111-4111-8111-111111111111";
const CRM = "9ae1f031-2222-4222-8222-222222222222";

console.log("the filter:");

test("a uuid is looked up in both columns - ours first, the CRM's second", () => {
  assert.equal(restaurantRefFilter(BRIDGE), `id.eq.${BRIDGE},crm_restaurant_id.eq.${BRIDGE}`);
  assert.equal(restaurantRefFilter(CRM), `id.eq.${CRM},crm_restaurant_id.eq.${CRM}`);
  assert.ok(UUID_RE.test(BRIDGE) && UUID_RE.test(CRM));
});

test("a non-uuid reference is only ever matched against crm_restaurant_id - Postgres refuses it against a uuid column", () => {
  assert.equal(restaurantRefFilter("acct_12345"), "crm_restaurant_id.eq.acct_12345");
  assert.equal(restaurantRefFilter(" acct_12345 "), "crm_restaurant_id.eq.acct_12345", "trimmed");
});

test("anything that cannot be a reference is null, never a filter that matches everything", () => {
  for (const bad of ["", " ", "a,b", "(x)", "a b", "x".repeat(129), null, undefined, 42, {}]) {
    assert.equal(restaurantRefFilter(bad), null, JSON.stringify(bad));
  }
  assert.ok(!REF_RE.test("a,b"), "a comma would split the PostgREST or()");
  // Dots are allowed (a CRM id could carry one) and are harmless: PostgREST
  // reads "crm_restaurant_id.eq.id.eq.x" as a comparison to the literal
  // string "id.eq.x", which matches nothing.
  assert.equal(restaurantRefFilter("id.eq.x"), "crm_restaurant_id.eq.id.eq.x");
});

console.log("\nevery CRM-facing lookup goes through it:");

test("bind resolves the whole map to local ids before writing - kiosk_devices.restaurant_id is a foreign key to ours", () => {
  const bind = src("app/api/crm/tablets/bind/route.ts");
  assert.match(bind, /const localIdOf = await resolveRestaurantIds\(wanted\)/);
  assert.match(bind, /restaurant_id: localId,/);
  assert.doesNotMatch(bind, /\.in\("id", wanted\)/, "the old lookup by our id alone");
  assert.match(bind, /unknown_restaurants\.push\(b\.restaurant_id\)/, "an id neither column knows is still reported back");
});

test("link, bootstrap, the logins routes and footer-stats use findRestaurantByRef", () => {
  for (const p of [
    "app/api/crm/tablets/link/route.ts",
    "app/api/kiosk/bootstrap/route.ts",
    "app/api/crm/restaurants/[id]/logins/route.ts",
    "app/api/crm/restaurants/[id]/footer-stats/route.ts",
  ]) {
    assert.match(src(p), /findRestaurantByRef</, p);
    assert.doesNotMatch(src(p), /\.eq\("id", (params\.id|restaurantId|row!\.restaurant_id!|id)\)/, `${p} still looks up by our id alone`);
  }
});

test("GET/POST /:id, provision, test order, test email, ticket preview and login print filter on both columns", () => {
  for (const p of [
    "app/api/crm/restaurants/[id]/route.ts",
    "app/api/crm/restaurants/[id]/test-email/route.ts",
    "app/api/crm/restaurants/[id]/ticket-preview/route.ts",
    "app/api/crm/restaurants/[id]/logins/print/route.ts",
    "lib/provision.ts",
    "lib/test-order.ts",
  ]) {
    const s = src(p);
    assert.match(s, /\.or\(restaurantRefFilter\((params\.id|restaurantId)\) \?\? "id\.eq\.00000000-0000-0000-0000-000000000000"\)/, p);
    assert.doesNotMatch(s, /\.eq\("id", (params\.id|restaurantId)\)/, `${p} still looks up by our id alone`);
  }
  // Two lookups in the [id] route (GET and POST), both converted.
  assert.equal((src("app/api/crm/restaurants/[id]/route.ts").match(/restaurantRefFilter\(params\.id\)/g) ?? []).length, 2);
});

test("a malformed reference falls through to an id nothing has, so it is a 404 and not a 500", () => {
  // The fallback filter is a uuid no row will ever carry; Postgres accepts
  // it and PostgREST answers no rows. restaurantRefFilter itself returns
  // null for the malformed input, so the two cannot be confused.
  assert.equal(restaurantRefFilter("not a ref"), null);
  assert.ok(UUID_RE.test("00000000-0000-0000-0000-000000000000"));
});

test("the contract says which id the CRM sends, and that the bridge resolves it", () => {
  const doc = src("docs/crm-bridge-contract.md");
  assert.match(doc, /`restaurant_id` in CRM calls is the CRM account id/);
  assert.match(doc, /crm_restaurant_id/);
});

console.log(`\n${passed} assertions passed.`);
