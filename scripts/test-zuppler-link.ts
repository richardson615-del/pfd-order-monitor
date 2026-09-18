/**
 * The way back to an order in Zuppler (M1b, Nick 2026-09-18).
 *
 * Zuppler hands us no link - raw_payload is the LoadOrder GraphQL response
 * and its selection set has no URL field - so the address comes from a
 * template the office sets once it knows the real shape. What has to be
 * true: placeholders substitute and encode, anything missing yields null
 * rather than half an address, no template means no link, and a
 * non-Zuppler order has no object at all.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zupplerAdminUrl, zupplerLinkFor, zupplerUrlTemplate } from "../lib/zuppler-link";
import { LOAD_ORDER_QUERY } from "../lib/zuppler-mapper";

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
const T = "https://cs.example/{restaurant_id}/orders/{order_uuid}?n={order_number}";
const V = { order_uuid: "7f3a-uuid", order_number: "1184", restaurant_id: "4471" };

console.log("why a template:");

test("the stored payload cannot carry a link - the LoadOrder selection set has no URL field", () => {
  assert.doesNotMatch(LOAD_ORDER_QUERY, /url|link|href/i);
  assert.match(src("lib/zuppler-mapper.ts"), /rawPayload: resp/);
});

console.log("\nthe template:");

test("placeholders substitute, URL-encoded", () => {
  assert.equal(zupplerAdminUrl(T, V), "https://cs.example/4471/orders/7f3a-uuid?n=1184");
  assert.equal(zupplerAdminUrl("https://cs.example/o/{order_uuid}", { ...V, order_uuid: "a b/c" }), "https://cs.example/o/a%20b%2Fc");
  assert.equal(zupplerAdminUrl("https://cs.example/orders", V), "https://cs.example/orders", "a template with no placeholders is a plain link");
});

test("null when the template is unset, not http(s), has an unknown placeholder, or a used value is missing", () => {
  assert.equal(zupplerAdminUrl(null, V), null);
  assert.equal(zupplerAdminUrl("", V), null);
  assert.equal(zupplerAdminUrl("cs.example/{order_uuid}", V), null, "no scheme");
  assert.equal(zupplerAdminUrl("https://cs.example/{order_id}", V), null, "a typo in the template is not an address");
  assert.equal(zupplerAdminUrl(T, { ...V, restaurant_id: null }), null, "half an address opens the wrong page");
  assert.equal(zupplerAdminUrl("https://cs.example/o/{order_uuid}", { ...V, restaurant_id: null }), "https://cs.example/o/7f3a-uuid", "a placeholder not used does not need a value");
  assert.equal(zupplerUrlTemplate({} as any), null);
  assert.equal(zupplerUrlTemplate({ ZUPPLER_ORDER_URL_TEMPLATE: "  " } as any), null);
  assert.equal(zupplerUrlTemplate({ ZUPPLER_ORDER_URL_TEMPLATE: T } as any), T);
});

console.log("\nthe object on the detail:");

test("a Zuppler order gets the ids and the link; without a template the link alone is null; other sources get nothing", () => {
  const order = { source: "zuppler", external_id: "7f3a-uuid", order_number: "1184" };
  const r = { zuppler_restaurant_id: "4471" };
  assert.deepEqual(zupplerLinkFor(order, r, T), { order_uuid: "7f3a-uuid", restaurant_id: "4471", admin_url: "https://cs.example/4471/orders/7f3a-uuid?n=1184" });
  assert.deepEqual(zupplerLinkFor(order, r, null), { order_uuid: "7f3a-uuid", restaurant_id: "4471", admin_url: null });
  assert.deepEqual(zupplerLinkFor(order, null, T), { order_uuid: "7f3a-uuid", restaurant_id: null, admin_url: null });
  assert.equal(zupplerLinkFor({ source: "email", external_id: "gmail-1", order_number: "9" }, r, T), null);
  assert.equal(zupplerLinkFor({ source: "test", external_id: null, order_number: "T1" }, r, T), null);
});

test("the detail route builds it from the env template and the restaurant's Zuppler id; the contract says so", () => {
  const detail = src("app/api/crm/orders/[id]/route.ts");
  assert.match(detail, /zuppler: zupplerLinkFor\(\{ source: row\.source, external_id: row\.external_id \?\? null, order_number: row\.order_number \}, restaurant, zupplerUrlTemplate\(\)\)/);
  assert.match(src("lib/crm-orders-data.ts"), /select\("id, crm_restaurant_id, name, zuppler_restaurant_id, prep_minutes/);
  assert.match(src(".env.example"), /^ZUPPLER_ORDER_URL_TEMPLATE=/m);
  const doc = src("docs/crm-bridge-contract.md");
  assert.match(doc, /\*\*`zuppler`\*\* \(M1b/);
  assert.match(doc, /ZUPPLER_ORDER_URL_TEMPLATE/);
  assert.match(doc, /never guessed/);
});

console.log(`\n${passed} assertions passed.`);
