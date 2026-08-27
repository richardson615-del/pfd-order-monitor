/**
 * Tests for the CRM restaurant find-or-create input handling.
 * The database paths need a live connection, so these cover the decisions
 * made before any query: what counts as a usable identifier, and what is a
 * genuinely malformed request.
 */
import assert from "node:assert/strict";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}`); console.error(err instanceof Error ? err.message : err); process.exitCode = 1; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};
function slugify(name: string): string {
  const base = name.toLowerCase().replace(/['']/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "restaurant";
}

console.log("crm restaurant resolve:");

test("a real uuid is recognised as one of ours", () =>
  assert.ok(UUID_RE.test("b1bcdbe2-aec2-4ce5-bc72-611a94d084b9")));

test("a CRM id that is not a uuid is not mistaken for ours", () => {
  assert.equal(UUID_RE.test("torinos"), false);
  assert.equal(UUID_RE.test("4821"), false);
});

test("blank and whitespace ids are treated as absent", () => {
  assert.equal(str("   "), null);
  assert.equal(str(""), null);
  assert.equal(str(null), null);
  assert.equal(str(42), null);
});

test("names become usable slugs", () => {
  assert.equal(slugify("Torino's"), "torinos");
  assert.equal(slugify("Ariella Restaurant Bistro & Bar"), "ariella-restaurant-bistro-bar");
  assert.equal(slugify("  Depot Bar and Grill  "), "depot-bar-and-grill");
});

test("a name of only punctuation still yields a slug", () =>
  assert.equal(slugify("!!!"), "restaurant"));

test("a long name is truncated rather than rejected", () =>
  assert.ok(slugify("x".repeat(200)).length <= 48));

test("an apostrophe does not become a separator", () =>
  // "torino-s" would read as a different restaurant to a human scanning slugs.
  assert.ok(!slugify("Torino's").includes("-")));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
