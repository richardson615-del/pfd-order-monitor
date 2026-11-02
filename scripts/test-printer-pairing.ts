/**
 * Pairing an Eatabit printer from the code on its screen. The printer that
 * asked must be able to collect its key exactly once; nobody else may.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultPrinterName, mayCollectKey, newDeviceKey, type PairRow } from "@/lib/printer-pairing";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const NOW = Date.parse("2026-11-02T18:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const DEV = "pfd-eatabit-a1b2c3d4e5f6";
const row = (over: Partial<PairRow> = {}): PairRow => ({
  code: "123456", device_id: DEV, expires_at: at(60_000), restaurant_id: null,
  linked_at: null, device_key: null, consumed_at: null, ...over,
});

console.log("printer pairing:");

test("keys look like the ones the admin panel issues", () => {
  assert.match(newDeviceKey(), /^PFD-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.notEqual(newDeviceKey(), newDeviceKey());
});

test("a pending code carries nothing to collect", () => {
  assert.equal(mayCollectKey(row(), DEV, NOW), false);
});

test("the printer that asked collects the key once it is paired", () => {
  assert.equal(mayCollectKey(row({ linked_at: at(0), device_key: "PFD-AAAA-BBBB-CCCC" }), DEV, NOW), true);
});

test("a paired code collected late is still good: the 30 minutes is the office's", () => {
  assert.equal(mayCollectKey(row({ expires_at: at(-1), linked_at: at(-2), device_key: "PFD-AAAA-BBBB-CCCC" }), DEV, NOW), true);
});

test("another device cannot collect it", () => {
  assert.equal(mayCollectKey(row({ linked_at: at(0), device_key: "PFD-AAAA-BBBB-CCCC" }), "someone-elses-device-id", NOW), false);
});

test("a second collection gets nothing", () => {
  assert.equal(mayCollectKey(row({ linked_at: at(0), consumed_at: at(1), device_key: null }), DEV, NOW), false);
  assert.equal(mayCollectKey(row({ linked_at: at(0), consumed_at: at(1), device_key: "PFD-AAAA-BBBB-CCCC" }), DEV, NOW), false);
});

test("an unnamed printer gets a name the office can find", () => {
  assert.equal(defaultPrinterName("123456"), "Printer 123456");
});

test("the printer route blanks the key after handing it over", () => {
  const route = src("app/api/print/link/route.ts");
  assert.match(route, /\.is\("consumed_at", null\)/);
  assert.match(route, /update\(\{ device_key: null \}\)/);
});

test("the office routes never return the key", () => {
  for (const p of ["app/api/admin/print-devices/pair/route.ts", "app/api/crm/printers/pair/route.ts"]) {
    assert.doesNotMatch(src(p), /device_key|deviceKey/);
  }
});

test("the CRM route is CRM-authenticated and the admin route admin-only", () => {
  assert.match(src("app/api/crm/printers/pair/route.ts"), /authorizeCrmWrite\(req\)/);
  assert.match(src("app/api/admin/print-devices/pair/route.ts"), /isCurrentUserAdmin\(\)/);
});

console.log(`${passed} passed`);
