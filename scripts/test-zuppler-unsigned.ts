/**
 * The Zuppler webhook's unsigned-call switch (2026-10-28, lib/zuppler-webhook-auth.ts).
 * Off by default; on, only a UUID-shaped order id gets through, and only to be
 * looked up at Zuppler. A signed call is unaffected either way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptUnsignedEnabled, isUuidShaped, zupplerWebhookDecision } from "@/lib/zuppler-webhook-auth";
import { refusedToRecover, RECOVER_MAX_PER_RUN } from "@/lib/zuppler-recover";

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

console.log(`\n${passed} assertions passed.`);
