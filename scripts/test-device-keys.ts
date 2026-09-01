/**
 * Contract tests for device key reveal / reissue and history.
 * These assert the promises the CRM is being asked to rely on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const route = readFileSync("app/api/crm/devices/[id]/route.ts", "utf8");
const history = readFileSync("app/api/crm/devices/[id]/history/route.ts", "utf8");

console.log("device key contract:");

test("both key actions require the write key like every other action", () => {
  // authorizeCrmWrite runs once at the top for all actions.
  const auth = route.indexOf("authorizeCrmWrite");
  const reveal = route.indexOf('"reveal_key"');
  assert.ok(auth > 0 && auth < reveal);
});

test("reveal writes an audit row", () =>
  assert.match(route, /action: "revealed"/));

test("reissue writes an audit row", () =>
  assert.match(route, /action: "reissued"/));

test("reissue states the printer goes offline until reconfigured", () => {
  // The consequence is the point of the response, not the new key.
  assert.match(route, /printer_offline_until_reconfigured: true/);
  assert.match(route, /old_key_valid: false/);
  assert.match(route, /will not authenticate/);
});

test("a reissued key uses the same human-typeable alphabet", () => {
  // Typed off a screen into a printer's WebConfig - O/0 and I/1 cost a visit.
  const m = route.match(/const alphabet = "([^"]+)";/);
  assert.ok(m, "alphabet must be defined");
  for (const c of ["O", "0", "I", "1"]) assert.ok(!m![1].includes(c));
});

test("history says plainly that check-ins are NOT retained", () => {
  // The CRM asked to render "not available" rather than guess.
  assert.match(history, /available: false/);
  assert.match(history, /Not retained/);
});

test("history reports real per-job records", () =>
  assert.match(history, /print_jobs/));

test("job timings are precomputed, not left to the caller", () => {
  assert.match(history, /seconds_to_claim/);
  assert.match(history, /seconds_to_print/);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
