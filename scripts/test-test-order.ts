/**
 * Assertions for the tablet's test order.
 *
 * Every other destination had one: a printer has test_print, an AEM
 * restaurant has test-email. The tablet had nothing, so proving a newly
 * installed one worked meant waiting for a real order, on a real restaurant,
 * during real service - which is the wrong moment to discover that nobody
 * tapped "Enable notifications".
 *
 * These pin the two things that make it safe to point at a live restaurant.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
const route = src("app/api/crm/restaurants/[id]/test-order/route.ts");

console.log("safe to point at a live restaurant:");

test("it never prints", () => {
  // A test of the tablet that also produced paper would put a fake order on
  // the spike in a working kitchen. The paper path has its own test.
  assert.match(route, /deliverToApp\(/);
  assert.doesNotMatch(route, /print_jobs/, "the route must not queue a printer job");
  assert.doesNotMatch(route, /print_devices/);
});

test("the order says on its own face that it is not real", () => {
  assert.match(route, /source: "test"/);
  assert.match(route, /do not make/i);
});

test("it carries a quantity, a modifier and a note", () => {
  // So the test proves the SCREEN, not merely that a notification arrived.
  // Those three are what a cook actually reads and what would break silently.
  assert.match(route, /2x Test item/);
  assert.match(route, /modifiers: \[/);
  assert.match(route, /notes:/);
});

console.log("\nfailing usefully:");

test("no subscribed device is refused BEFORE an order is written", () => {
  // With nothing to push to, the test would record a failure and tell whoever
  // is standing at the tablet nothing they could act on.
  const check = route.indexOf("push_subscriptions");
  const insert = route.indexOf('.from("orders")');
  assert.ok(check > -1 && insert > -1);
  assert.ok(check < insert, "the subscription check must come before the insert");
  assert.match(route, /Enable notifications/, "it must name the step that was missed");
});

test("a push that reached nobody is not reported as success", () => {
  assert.match(route, /push\.sent === 0/);
  assert.match(route, /devices_reached: 0/);
});

test("it reports how many devices it actually reached", () => {
  assert.match(route, /devices_reached: push\.sent/);
});

console.log("\nthe setup order it protects:");

test("it works before app_expected is turned on, and says so", () => {
  // This is the order the runbook depends on: prove the tablet chimes FIRST,
  // then turn app_expected on. Reversed, every order raises a critical alert
  // until somebody enables notifications.
  assert.match(route, /appExpected: !!restaurant\.app_expected/);
  assert.match(route, /warning:/);

  // Exactly one refusal, and it is the missing-subscription one. A second
  // would almost certainly be "not app_expected yet", which would block the
  // very step this exists to make possible.
  const refusals = route.match(/status: 409/g) ?? [];
  assert.equal(refusals.length, 1, "there should be exactly one 409, for no subscribed device");
  assert.match(route, /Enable notifications[\s\S]*status: 409/);
});

console.log(`\n${passed} assertions passed.`);
