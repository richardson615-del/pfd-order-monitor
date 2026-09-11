/**
 * printer_expected has to be WRITTEN, not just read.
 *
 * It gates the "No printer" health warning so that the hundreds of channel
 * restaurants which will never print a ticket stay quiet. Migration 014
 * backfilled it once and then nothing in the codebase ever set it again, so
 * every restaurant onboarded through the CRM console since had a registered,
 * working printer and the flag still false - which silently disabled the
 * warning for exactly the sites that own a printer.
 *
 * A check nobody can see failing is worse than no check, so these assert the
 * wiring at every point a device is registered or moved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateHealth, type HealthSnapshot } from "@/lib/health";

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

console.log("every path that registers or moves a device sets it:");

for (const [label, path] of [
  ["CRM registers a device", "app/api/crm/devices/route.ts"],
  ["CRM reassigns a device", "app/api/crm/devices/[id]/route.ts"],
  ["admin panel registers or reassigns", "app/api/admin/print-devices/route.ts"],
] as const) {
  test(label, () => {
    const s = src(path);
    assert.match(s, /markPrinterExpected\(/, `${path} never sets printer_expected`);
    assert.match(s, /from "@\/lib\/restaurant-resolve"/);
  });
}

test("a reassign marks the restaurant receiving the printer", () => {
  const s = src("app/api/crm/devices/[id]/route.ts");
  assert.match(s, /markPrinterExpected\(target\.id\)/);
});

console.log("\nwhat it must never do:");

test("it is never cleared when a device is deactivated", () => {
  // The intention outliving the hardware is the whole point: a site that had
  // its printer taken away is exactly what the warning is for, so clearing
  // the flag would silence the one case worth hearing about.
  const lib = src("lib/restaurant-resolve.ts");
  assert.doesNotMatch(lib, /printer_expected: false/);
  for (const p of ["app/api/crm/devices/[id]/route.ts", "app/api/admin/print-devices/route.ts"]) {
    assert.doesNotMatch(src(p), /printer_expected: false/, `${p} clears the flag`);
  }
});

test("a failure to set it cannot fail the registration", () => {
  // Registering a printer is a site visit. It must not fail because a
  // monitoring hint could not be written.
  const lib = src("lib/restaurant-resolve.ts");
  const fn = lib.slice(lib.indexOf("export async function markPrinterExpected"));
  assert.match(fn.slice(0, 900), /try \{/);
  assert.match(fn.slice(0, 900), /catch/);
});

console.log("\nand the warning it exists to gate:");

const base: HealthSnapshot = {
  devices: [],
  inboxes: [],
  restaurantsWithoutDevice: [],
  restaurantsWithoutAppDevice: [],
  tabletsNotWatching: [],
  pendingJobs: [],
  failedJobs: [],
  unreconciledOrders: [],
  unsentEmailJobs: [],
  undeliveredAppAlerts: [],
  webhook: { lastReceiptAt: null, lastAcceptedAt: null, recentTotal: 0, recentRejected: 0 },
};
const NOW = new Date("2026-09-11T12:00:00Z");

test("a restaurant meant to have a printer and lacking one is reported", () => {
  const issues = evaluateHealth(
    { ...base, restaurantsWithoutDevice: [{ id: "r1", name: "China One" }] },
    NOW
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "restaurant_no_device:r1");
});

test("it stays a WARNING at channel scale, never a page", () => {
  // Hundreds of channel restaurants will never print. This check is only
  // tolerable because it cannot wake anyone up.
  const issues = evaluateHealth(
    {
      ...base,
      restaurantsWithoutDevice: Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`,
        name: `Restaurant ${i}`,
      })),
    },
    NOW
  );
  assert.equal(issues.length, 50);
  assert.ok(issues.every((i) => i.severity === "warning"));
});

console.log(`\n${passed} assertions passed.`);
