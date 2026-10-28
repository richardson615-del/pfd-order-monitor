/**
 * The Zuppler webhook's unsigned-call switch (2026-10-28, lib/zuppler-webhook-auth.ts).
 * Off by default; on, only a UUID-shaped order id gets through, and only to be
 * looked up at Zuppler. A signed call is unaffected either way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptUnsignedEnabled, isUuidShaped, zupplerWebhookDecision } from "@/lib/zuppler-webhook-auth";

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

console.log(`\n${passed} assertions passed.`);
