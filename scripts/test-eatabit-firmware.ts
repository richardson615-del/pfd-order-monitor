/**
 * Remote firmware updates for Eatabit printers (lib/printers/eatabit-firmware.ts):
 * who is offered what, and the reply the ESP32 parses.
 */
import assert from "node:assert/strict";
import { existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { RELEASE_PLAN, RELEASE_PLANS, eatabitVersion, firmwarePath, firmwareReply, pickFirmware, productOf, versionRank, type FirmwarePlan } from "@/lib/printers/eatabit-firmware";
import { eatabitPrinterName } from "@/lib/printers/text-only";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

console.log("eatabit firmware:");

const A = "pfd-eatabit-aabbccdd8f30";
const B = "pfd-eatabit-aabbccdd1234";
const rel = (version: string) => ({ version, file: `pfd-eatabit-${version}-update.bin`, size: 100, md5: "0".repeat(32) });
const plan: FirmwarePlan = { stable: rel("2.9.0"), test: { ...rel("2.9.1"), devices: [A] } };

test("versions compare as numbers, not text", () => {
  assert.ok(versionRank("2.10.0") > versionRank("2.9.3"));
  assert.ok(versionRank("2.9.1") > versionRank("2.9.0"));
  assert.equal(versionRank("2.9"), versionRank("2.9.0"));
  assert.equal(versionRank("junk"), 0);
});

test("a test device gets the test build", () => {
  assert.equal(pickFirmware(plan, A, "2.9.0")?.version, "2.9.1");
  assert.equal(pickFirmware(plan, A.toUpperCase(), "2.9.0")?.version, "2.9.1");
});

test("everyone else gets stable, and only when it is newer", () => {
  assert.equal(pickFirmware(plan, B, "2.8.5")?.version, "2.9.0");
  assert.equal(pickFirmware(plan, B, "2.9.0"), null);
  assert.equal(pickFirmware(plan, B, "2.9.1"), null);
});

test("never a downgrade, even for a test device", () => {
  assert.equal(pickFirmware(plan, A, "2.9.1"), null);
  assert.equal(pickFirmware(plan, A, "3.0.0"), null);
});

test("test release object does not carry the device list", () => {
  assert.equal("devices" in (pickFirmware(plan, A, "2.9.0") as object), false);
});

test("no plan, no offer", () => {
  assert.equal(pickFirmware({ stable: null, test: null }, A, "1.0.0"), null);
});

test("reply is line-per-field with an absolute url", () => {
  assert.equal(firmwareReply(null, "https://x.test"), "update=none");
  assert.equal(
    firmwareReply(rel("2.9.1"), "https://pfd-order-monitor.vercel.app"),
    "update=2.9.1\nurl=https://pfd-order-monitor.vercel.app/firmware/eatabit/pfd-eatabit-2.9.1-update.bin\nsize=100\nmd5=" + "0".repeat(32),
  );
});

test("version read from both user-agent forms", () => {
  assert.equal(eatabitVersion("pfd-eatabit/2.9.0"), "2.9.0");
  assert.equal(eatabitVersion("pfd-eatabit 2.8.5"), "2.8.5");
  assert.equal(eatabitVersion("EPSON"), null);
  assert.equal(eatabitPrinterName("pfd-eatabit 2.8.5"), "PFD Eatabit 2.8.5");
  assert.equal(eatabitPrinterName("pfd-eatabit/2.9.0"), "PFD Eatabit 2.9.0");
});

test("old Eatabit firmware (no Product) is eatabit; order boxes are orderbox", () => {
  assert.equal(productOf(null, "pfd-eatabit-c05d89888f30"), "eatabit");
  assert.equal(productOf(null, "pfd-orderbox-aabbccddeeff"), "orderbox");
  assert.equal(productOf("orderbox", "pfd-orderbox-aabbccddeeff"), "orderbox");
  assert.equal(productOf("ORDERBOX", "x"), "orderbox");
  assert.equal(productOf("toaster", "pfd-eatabit-c05d89888f30"), null);
});

test("an order box is never offered an Eatabit build", () => {
  // even on a low version that the eatabit stable build would beat
  const ob = pickFirmware(RELEASE_PLANS.orderbox, "pfd-orderbox-aabbccddeeff", "0.0.1");
  if (ob) assert.match(ob.file, /^pfd-orderbox-/);
  for (const r of [RELEASE_PLANS.eatabit.stable, RELEASE_PLANS.eatabit.test]) if (r) assert.match(r.file, /^pfd-eatabit-/);
});

test("order box replies point at the order box folder", () => {
  assert.equal(firmwarePath("orderbox"), "/firmware/orderbox/");
  assert.match(firmwareReply(rel("1.0.1"), "https://x.test", "orderbox"), /url=https:\/\/x\.test\/firmware\/orderbox\//);
});

test("every release in every plan has its file, size and md5 right", () => {
  const all = (Object.entries(RELEASE_PLANS) as [string, FirmwarePlan][]).flatMap(([prod, pl]) =>
    ([pl.stable, pl.test].filter(Boolean) as { file: string; size: number; md5: string }[]).map((r) => ({ ...r, prod })));
  for (const r of all) {
    const p = path.join(process.cwd(), "public/firmware", r.prod, r.file);
    assert.ok(existsSync(p), `missing ${r.file}`);
    assert.equal(statSync(p).size, r.size, `${r.file} size`);
    assert.equal(createHash("md5").update(readFileSync(p)).digest("hex"), r.md5, `${r.file} md5`);
  }
});

test("test devices are device ids, never device keys", () => {
  for (const d of RELEASE_PLAN.test?.devices ?? []) assert.match(d, /^pfd-eatabit-[0-9a-f]{12}$/);
  for (const d of RELEASE_PLANS.orderbox.test?.devices ?? []) assert.match(d, /^pfd-orderbox-[0-9a-f]{12}$/);
});

console.log(`${passed} passed`);
