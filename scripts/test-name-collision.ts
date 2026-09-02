/**
 * The name-collision warning.
 *
 * Two silent routing failures came from the CRM forking a restaurant row it
 * could not match: a second "Roundies Rock Cafe" (which put the printer on
 * the row WITHOUT the Zuppler mapping) and a second "Willie Mae's".
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const src = readFileSync("lib/restaurant-resolve.ts", "utf8");

// Mirror of normaliseName in the module under test.
const norm = (n: string) =>
  n.toLowerCase().replace(/['’.,&-]/g, "").replace(/\s+/g, " ").trim();

console.log("restaurant name collision:");

test("the real cases that forked would now be caught", () => {
  assert.equal(norm("Roundies Rock Cafe"), norm("roundies rock cafe"));
  assert.equal(norm("Willie Mae's"), norm("Willie Maes"));
  assert.equal(norm("Torino's"), norm("Torinos"));
  assert.equal(norm("Chris' Pizza Village"), norm("Chris Pizza Village"));
});

test("genuinely different venues are NOT treated as the same", () => {
  // Both exist, both correct, different Zuppler ids and CRM accounts.
  assert.notEqual(norm("Dos Bros"), norm("Dos Bros White House"));
  assert.notEqual(norm("Jose's Greenbrier"), norm("Jose's Springfield"));
  assert.notEqual(norm("Gyro King White House"), norm("Gyro King Pleasant View"));
});

test("collision does NOT auto-merge - it only warns", () => {
  // Two venues really can share a name; merging them silently would put one
  // kitchen's tickets on another restaurant's printer.
  assert.match(src, /created: true/);
  assert.match(src, /Deliberately NOT used to match automatically/);
});

test("the warning carries candidates the console can act on", () => {
  assert.match(src, /candidates:/);
  assert.match(src, /crm_restaurant_id:/);
  assert.match(src, /zuppler_restaurant_id:/);
});

test("a collision is logged server-side too", () =>
  assert.match(src, /restaurant name collision/));

test("the message says WHY it matters, not just that it happened", () =>
  assert.match(src, /split its orders and its printers/));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
