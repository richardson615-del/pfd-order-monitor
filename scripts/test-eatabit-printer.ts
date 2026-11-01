/**
 * The Eatabit firmware's two asks of the print endpoint: it is told apart
 * by its User-Agent (so it gets all-text tickets), and the route's prep
 * time rules match the tablet's Accept.
 */
import assert from "node:assert/strict";
import { isTextOnlyPrinter } from "@/app/api/print/epson/route";
import { readyByFor } from "@/lib/ready-timer";
import { isValidPrepMinutes } from "@/lib/countdown";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

console.log("eatabit printer:");

test("an Eatabit identifies itself by firmware name", () => {
  assert.equal(isTextOnlyPrinter("pfd-eatabit 2.0.0"), true);
});

test("Epson printers and unknown agents keep the raster ticket", () => {
  assert.equal(isTextOnlyPrinter("EPSON TM-m30III"), false);
  assert.equal(isTextOnlyPrinter(null), false);
  assert.equal(isTextOnlyPrinter(""), false);
});

test("prep minutes from the box obey the tablet's limits", () => {
  assert.equal(isValidPrepMinutes(15), true);
  assert.equal(isValidPrepMinutes(0), false);
  assert.equal(isValidPrepMinutes(181), false);
  assert.equal(isValidPrepMinutes("15" as unknown), false);
});

test("ready_by counts from the first acceptance, not from re-timing", () => {
  assert.equal(readyByFor("2026-11-01T18:00:00.000Z", 20), "2026-11-01T18:20:00.000Z");
});

console.log(`${passed} passed`);
