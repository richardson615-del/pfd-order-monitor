/**
 * The Zuppler webhook's unsigned-call switch (2026-10-28, lib/zuppler-webhook-auth.ts).
 * Off by default; on, only a UUID-shaped order id gets through, and only to be
 * looked up at Zuppler. A signed call is unaffected either way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptUnsignedEnabled, isUuidShaped, zupplerWebhookDecision } from "@/lib/zuppler-webhook-auth";
import { refusedToRecover, RECOVER_MAX_PER_RUN, unmappedToRecover, zupplerIdFromDetail, MAPPED_RECOVER_WINDOW_MS } from "@/lib/zuppler-recover";

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

const UUID = "3f2a9c1e-8b4d-4e2f-9a1b-0c6d7e8f9a0b";
const ON = { ZUPPLER_ACCEPT_UNSIGNED: "1" };

test("off unless the env says so", () => {
  assert.equal(acceptUnsignedEnabled({}), false);
  assert.equal(acceptUnsignedEnabled({ ZUPPLER_ACCEPT_UNSIGNED: "0" }), false);
  assert.equal(acceptUnsignedEnabled({ ZUPPLER_ACCEPT_UNSIGNED: " On " }), true);
});

test("switch off: an unsigned call is refused, even naming a real-looking order", () => {
  assert.equal(zupplerWebhookDecision({ tokenOk: false, orderUuid: UUID, env: {} }), "refuse");
});

test("switch on: an unsigned call naming a UUID is verified at Zuppler; anything else is refused", () => {
  assert.equal(zupplerWebhookDecision({ tokenOk: false, orderUuid: UUID, env: ON }), "unsigned_verify");
  assert.equal(zupplerWebhookDecision({ tokenOk: false, orderUuid: null, env: ON }), "refuse");
  assert.equal(zupplerWebhookDecision({ tokenOk: false, orderUuid: "1 OR 1=1", env: ON }), "refuse");
  assert.equal(isUuidShaped(`${UUID}x`), false);
});

test("a signed call is signed whatever the switch says", () => {
  assert.equal(zupplerWebhookDecision({ tokenOk: true, orderUuid: null, env: {} }), "signed");
  assert.equal(zupplerWebhookDecision({ tokenOk: true, orderUuid: UUID, env: ON }), "signed");
});

test("the route asks the decision, refuses on refuse, and marks unsigned receipts", () => {
  const route = readFileSync("app/api/ingest/zuppler/route.ts", "utf8");
  assert.match(route, /zupplerWebhookDecision\(\{ tokenOk/);
  assert.match(route, /if \(decision === "refuse"\) \{/);
  assert.match(route, /unsigned: no token; order fetched from Zuppler's API/);
});

// Refused-order recovery (2026-11-18): which refused deliveries the monitor fetches.
{
  const now = Date.parse("2026-11-18T20:00:00Z");
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const A = "3d13830c-1111-4222-8333-444455556666";
  const B = "aaaaaaaa-1111-4222-8333-444455556666";
  test("recovery: an old enough refusal not in the system is fetched, once", () => {
    assert.deepEqual(refusedToRecover([{ order_uuid: A, received_at: at(10) }, { order_uuid: A, received_at: at(9) }], new Set(), now), [A]);
  });
  test("recovery: skips orders already in, too fresh, too old, or not uuid-shaped", () => {
    assert.deepEqual(refusedToRecover([{ order_uuid: A, received_at: at(10) }], new Set([A]), now), []);
    assert.deepEqual(refusedToRecover([{ order_uuid: A, received_at: at(1) }], new Set(), now), []);
    assert.deepEqual(refusedToRecover([{ order_uuid: A, received_at: at(25 * 60) }], new Set(), now), []);
    assert.deepEqual(refusedToRecover([{ order_uuid: "1 OR 1=1", received_at: at(10) }], new Set(), now), []);
  });
  test("recovery: reads the id from the stored body when order_uuid is empty, oldest first, capped", () => {
    assert.deepEqual(refusedToRecover([{ raw_body: JSON.stringify({ order_uuid: B }), received_at: at(5) }, { order_uuid: A, received_at: at(30) }], new Set(), now), [A, B]);
    const many = Array.from({ length: 9 }, (_, i) => ({ order_uuid: `aaaaaaa${i}-1111-4222-8333-444455556666`, received_at: at(10 + i) }));
    assert.equal(refusedToRecover(many, new Set(), now).length, RECOVER_MAX_PER_RUN);
  });
}

// --- orders dropped as unmapped whose listing was registered afterwards (2026-11-20, Perry's Smokin Pig) ---
{
  const now = Date.parse("2026-11-20T17:40:00Z");
  const U = (n: number) => `ddf5ebfc-0000-4000-8000-00000000000${n}`;
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  assert.equal(zupplerIdFromDetail("zuppler_restaurant_id 29897"), "29897");
  assert.equal(zupplerIdFromDetail("recovered by the monitor ... - zuppler_restaurant_id 32770"), "32770");
  assert.equal(zupplerIdFromDetail("token mismatch"), null);
  const rows = [
    { order_uuid: U(1), detail: "zuppler_restaurant_id 29897", received_at: at(25) },
    { order_uuid: U(1), detail: "zuppler_restaurant_id 29897", received_at: at(24) }, // Zuppler's second delivery of the same order
    { order_uuid: U(2), detail: "zuppler_restaurant_id 29897", received_at: at(90) },
    { order_uuid: U(3), detail: "zuppler_restaurant_id 55555", received_at: at(10) }, // still unmapped
    { order_uuid: U(4), detail: "zuppler_restaurant_id 29897", received_at: at(MAPPED_RECOVER_WINDOW_MS / 60_000 + 5) }, // too old for a live ticket
    { order_uuid: U(5), detail: "zuppler_restaurant_id 29897", received_at: at(5) }, // already in the system
    { order_uuid: "not-a-uuid", detail: "zuppler_restaurant_id 29897", received_at: at(5) },
    { order_uuid: U(6), detail: null, received_at: at(5) },
  ];
  // Oldest first, each order once, only the mapped listing, nothing already here or too old.
  assert.deepEqual(unmappedToRecover(rows, new Set(["29897"]), new Set([U(5)]), now), [U(2), U(1)]);
  assert.deepEqual(unmappedToRecover(rows, new Set(), new Set(), now), []);
  assert.equal(unmappedToRecover(rows, new Set(["29897"]), new Set(), now, 1).length, 1);
  const check = readFileSync("app/api/monitor/check/route.ts", "utf8");
  assert.ok(check.indexOf("recoverNewlyMappedZupplerOrders()") < check.indexOf("evaluateHealth("), "runs before the health checks");
}

console.log(`\n${passed} assertions passed.`);
