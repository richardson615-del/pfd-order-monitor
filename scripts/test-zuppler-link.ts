/**
 * The way back to an order in Zuppler (M1b, Nick 2026-09-18).
 *
 * Zuppler hands us no link - raw_payload is the LoadOrder GraphQL response
 * and its selection set has no URL field - but the shape is known from a
 * real link: customer-service.zuppler.com/#/lists/<list id>/order/<order
 * uuid>, the list id shared by every restaurant. What has to be true: the
 * default template is that shape and needs only the list id; the order
 * segment is external_id and must be uuid-shaped; anything missing yields
 * null rather than half an address; the override template still works;
 * a non-Zuppler order has no object at all.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ZUPPLER_CS_URL_TEMPLATE_DEFAULT,
  zupplerAdminUrl,
  zupplerLinkFor,
  zupplerListId,
  zupplerUrlTemplate,
} from "../lib/zuppler-link";
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
const LIST = "5cc7eab5-ea1d-4985-b864-92afc523eb1e";
const UUID = "5a06d750-3cd8-4c09-913d-8000f676a445";
const NICKS_LINK = `https://customer-service.zuppler.com/#/lists/${LIST}/order/${UUID}`;
const V = { list_id: LIST, order_uuid: UUID, order_number: "1184", restaurant_id: "4471" };

console.log("why a template, and which:");

test("the stored payload cannot carry a link - the LoadOrder selection set has no URL field - and external_id IS the order uuid", () => {
  assert.doesNotMatch(LOAD_ORDER_QUERY, /url|link|href/i);
  assert.match(src("lib/zuppler-mapper.ts"), /rawPayload: resp/);
  // The mapper stores order.uuid as externalId - the same value the webhook
  // sends as order_uuid and the same segment the CS link ends in.
  assert.match(src("lib/zuppler-mapper.ts"), /externalId: str\(order\.uuid\)/);
  assert.match(src("lib/zuppler-mapper.ts"), /order\(id: \$order_uuid\)/);
});

test("the default template is the real customer-service shape and reproduces Nick's link exactly", () => {
  assert.equal(ZUPPLER_CS_URL_TEMPLATE_DEFAULT, "https://customer-service.zuppler.com/#/lists/{list_id}/order/{order_uuid}");
  assert.equal(zupplerAdminUrl(ZUPPLER_CS_URL_TEMPLATE_DEFAULT, V), NICKS_LINK);
  assert.equal(zupplerUrlTemplate({} as any), ZUPPLER_CS_URL_TEMPLATE_DEFAULT, "the default needs no env");
  assert.equal(zupplerUrlTemplate({ ZUPPLER_ORDER_URL_TEMPLATE: "https://x.example/{order_uuid}" } as any), "https://x.example/{order_uuid}", "an override wins");
  assert.equal(zupplerListId({} as any), null);
  assert.equal(zupplerListId({ ZUPPLER_CS_LIST_ID: ` ${LIST} ` } as any), LIST);
});

console.log("\nthe template:");

test("placeholders substitute, URL-encoded; a template with none is a plain link", () => {
  assert.equal(zupplerAdminUrl("https://x.example/{restaurant_id}/o/{order_uuid}?n={order_number}", V), `https://x.example/4471/o/${UUID}?n=1184`);
  assert.equal(zupplerAdminUrl("https://x.example/n/{order_number}", { ...V, order_number: "a b/c" }), "https://x.example/n/a%20b%2Fc");
  assert.equal(zupplerAdminUrl("https://x.example/orders", V), "https://x.example/orders");
});

test("null when the template is not http(s), has an unknown placeholder, a used value is missing, or the order uuid is not one", () => {
  assert.equal(zupplerAdminUrl(null, V), null);
  assert.equal(zupplerAdminUrl("", V), null);
  assert.equal(zupplerAdminUrl("customer-service.zuppler.com/#/lists/{list_id}/order/{order_uuid}", V), null, "no scheme");
  assert.equal(zupplerAdminUrl("https://x.example/{order_id}", V), null, "a typo in the template is not an address");
  assert.equal(zupplerAdminUrl(ZUPPLER_CS_URL_TEMPLATE_DEFAULT, { ...V, list_id: null }), null, "no list id, no link - half an address opens the wrong page");
  assert.equal(zupplerAdminUrl(ZUPPLER_CS_URL_TEMPLATE_DEFAULT, { ...V, order_uuid: "gmail-18c2f0" }), null, "an external_id that is not a uuid is not that order's address");
  assert.equal(zupplerAdminUrl("https://x.example/n/{order_number}", { ...V, list_id: null, restaurant_id: null }), "https://x.example/n/1184", "a placeholder not used does not need a value");
});

console.log("\nthe object on the detail:");

test("a Zuppler order gets the ids and the link; without the list id the link alone is null; other sources get nothing", () => {
  const order = { source: "zuppler", external_id: UUID, order_number: "1184" };
  const r = { zuppler_restaurant_id: "4471" };
  assert.deepEqual(zupplerLinkFor(order, r, ZUPPLER_CS_URL_TEMPLATE_DEFAULT, LIST), { order_uuid: UUID, restaurant_id: "4471", admin_url: NICKS_LINK });
  assert.deepEqual(zupplerLinkFor(order, r, ZUPPLER_CS_URL_TEMPLATE_DEFAULT, null), { order_uuid: UUID, restaurant_id: "4471", admin_url: null });
  assert.deepEqual(zupplerLinkFor(order, null, ZUPPLER_CS_URL_TEMPLATE_DEFAULT, LIST), { order_uuid: UUID, restaurant_id: null, admin_url: NICKS_LINK }, "the CS link does not need the restaurant");
  assert.equal(zupplerLinkFor({ source: "email", external_id: "gmail-1", order_number: "9" }, r, ZUPPLER_CS_URL_TEMPLATE_DEFAULT, LIST), null);
  assert.equal(zupplerLinkFor({ source: "test", external_id: null, order_number: "T1" }, r, ZUPPLER_CS_URL_TEMPLATE_DEFAULT, LIST), null);
});

test("the detail route builds it from the env; .env.example and the contract say so", () => {
  const detail = src("app/api/crm/orders/[id]/route.ts");
  assert.match(detail, /zuppler: zupplerLinkFor\(\{ source: row\.source, external_id: row\.external_id \?\? null, order_number: row\.order_number \}, restaurant, zupplerUrlTemplate\(\), zupplerListId\(\)\)/);
  assert.match(src("lib/crm-orders-data.ts"), /select\("id, crm_restaurant_id, name, zuppler_restaurant_id, prep_minutes/);
  const env = src(".env.example");
  assert.match(env, /^ZUPPLER_CS_LIST_ID=/m);
  assert.match(env, /^ZUPPLER_ORDER_URL_TEMPLATE=/m);
  const doc = src("docs/crm-bridge-contract.md");
  assert.match(doc, /\*\*`zuppler`\*\* \(M1b/);
  assert.match(doc, /customer-service\.zuppler\.com\/#\/lists\/<list id>\/order\/<order uuid>/);
  assert.match(doc, /ZUPPLER_CS_LIST_ID/);
});

console.log(`\n${passed} assertions passed.`);
