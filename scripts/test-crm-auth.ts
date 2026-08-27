/**
 * Tests for the CRM write-bridge auth guard.
 * Run with: npm test
 */
import assert from "node:assert/strict";
import { authorizeCrmWrite, MIN_CRM_KEY_LENGTH } from "@/lib/crm-auth";

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

const GOOD = "k".repeat(MIN_CRM_KEY_LENGTH);
const req = (auth?: string) =>
  ({ headers: { get: (h: string) => (h.toLowerCase() === "authorization" ? auth ?? null : null) } }) as any;

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

console.log("crm write-bridge auth:");

test("an unset key disables the bridge with 503, not 401", () =>
  withEnv({ CRM_WRITE_KEY: undefined }, () => {
    const r = authorizeCrmWrite(req(`Bearer ${GOOD}`));
    assert.equal(r?.status, 503);
    assert.match(r!.error, /not set/);
  }));

test("a short key is refused as misconfiguration", () =>
  withEnv({ CRM_WRITE_KEY: "short" }, () => {
    const r = authorizeCrmWrite(req("Bearer short"));
    assert.equal(r?.status, 503);
    assert.match(r!.error, /shorter than/);
  }));

test("reusing the READ key as the write key is refused", () =>
  withEnv({ CRM_WRITE_KEY: GOOD, CRM_STATUS_READ_KEY: GOOD }, () => {
    const r = authorizeCrmWrite(req(`Bearer ${GOOD}`));
    assert.equal(r?.status, 503);
    assert.match(r!.error, /must not equal/);
  }));

test("a distinct read key is fine", () =>
  withEnv({ CRM_WRITE_KEY: GOOD, CRM_STATUS_READ_KEY: "r".repeat(MIN_CRM_KEY_LENGTH) }, () =>
    assert.equal(authorizeCrmWrite(req(`Bearer ${GOOD}`)), null)));

test("the correct key is authorised, bare or Bearer", () =>
  withEnv({ CRM_WRITE_KEY: GOOD, CRM_STATUS_READ_KEY: undefined }, () => {
    assert.equal(authorizeCrmWrite(req(`Bearer ${GOOD}`)), null);
    assert.equal(authorizeCrmWrite(req(GOOD)), null);
  }));

test("a wrong key of the SAME length is rejected", () =>
  withEnv({ CRM_WRITE_KEY: GOOD, CRM_STATUS_READ_KEY: undefined }, () => {
    // Equal length is the case timingSafeEqual actually has to decide, so it
    // is the one worth asserting - a length mismatch would short-circuit.
    const wrong = "x".repeat(MIN_CRM_KEY_LENGTH);
    assert.equal(wrong.length, GOOD.length);
    assert.equal(authorizeCrmWrite(req(`Bearer ${wrong}`))?.status, 401);
  }));

test("a missing or empty header is rejected", () =>
  withEnv({ CRM_WRITE_KEY: GOOD, CRM_STATUS_READ_KEY: undefined }, () => {
    assert.equal(authorizeCrmWrite(req(undefined))?.status, 401);
    assert.equal(authorizeCrmWrite(req("Bearer   "))?.status, 401);
  }));

test("a key that is a PREFIX of the real one is rejected", () =>
  withEnv({ CRM_WRITE_KEY: GOOD, CRM_STATUS_READ_KEY: undefined }, () =>
    assert.equal(authorizeCrmWrite(req(`Bearer ${GOOD.slice(0, -1)}`))?.status, 401)));

console.log(
  process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`
);
