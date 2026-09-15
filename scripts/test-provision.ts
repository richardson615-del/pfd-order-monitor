/**
 * Going live on the tablet as one call (E1).
 *
 * What is worth pinning: the username rule is the restaurant's name and
 * nothing a person has to invent; the collision rule is a suffix and the
 * first free one wins; a second call changes nothing and never resets a
 * password; the create-or-ensure endpoint accepts settings and reports a
 * Zuppler conflict as a code the CRM can act on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { usernameCandidates } from "@/lib/provision";
import { isValidUsername } from "@/lib/usernames";

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

console.log("the username comes from the name:");

test("a restaurant name slugs to a valid username, apostrophes and ampersands handled", () => {
  assert.equal(usernameCandidates("Willie Mae's")[0], "willie-maes");
  assert.equal(usernameCandidates("Ariella Restaurant Bistro & Bar")[0], "ariella-restaurant");
  assert.equal(usernameCandidates("  Larry's   Restaurant ")[0], "larrys-restaurant");
  for (const c of usernameCandidates("Willie Mae's")) assert.ok(isValidUsername(c), c);
});

test("collisions get a numeric suffix, first free wins, and the list is bounded", () => {
  const c = usernameCandidates("Larry's");
  assert.deepEqual(c.slice(0, 3), ["larrys", "larrys-2", "larrys-3"]);
  assert.equal(c.length, 20);
});

test("a name with nothing usable in it still yields a username", () => {
  assert.equal(usernameCandidates("!!!")[0], "tablet");
  assert.equal(usernameCandidates("")[0], "tablet");
});

test("a very long name is cut so the suffix still fits the 31-character limit", () => {
  const c = usernameCandidates("The Absolutely Enormous Restaurant Name Of Springfield Tennessee");
  assert.ok(c[0].length <= 24, c[0]);
  assert.ok(c.every((x) => x.length <= 31 && isValidUsername(x)));
});

console.log("\nthe endpoint:");

test("provision is bearer-gated, idempotent by construction, and never resets a password", () => {
  const route = src("app/api/crm/restaurants/[id]/provision/route.ts");
  assert.match(route, /authorizeCrmWrite\(req\)/);
  assert.match(route, /provisionRestaurant\(params\.id, actor\)/);
  const lib = src("lib/provision.ts");
  assert.match(lib, /if \(links\?\.length\) \{/, "an existing login is reported, not replaced");
  assert.doesNotMatch(lib, /updateUserById|password_reset/, "no password is ever reset here");
  assert.match(lib, /if \(!r\.is_active\)/);
  assert.match(lib, /if \(!r\.app_expected\)/);
  assert.match(lib, /changed\.push\("login"\)/);
});

test("the login it creates is the same shape the logins route creates", () => {
  const lib = src("lib/provision.ts");
  assert.match(lib, /email_confirm: true/);
  assert.match(lib, /role: "staff"/);
  assert.match(lib, /password_current: password/);
  assert.match(lib, /action: "created"/);
});

test("create-or-ensure takes settings, a single zuppler id, and names a conflict by code", () => {
  const route = src("app/api/crm/restaurants/route.ts");
  assert.match(route, /if \("timezone" in body\)/);
  assert.match(route, /if \("app_expected" in body\)/);
  assert.match(route, /if \("display_mode" in body\)/);
  assert.match(route, /code: "invalid_timezone"/);
  assert.match(route, /body\.zuppler_restaurant_id/);
  assert.match(route, /code: outcome\.status === 409 \? "zuppler_id_conflict" : "invalid_zuppler_id"/);
  assert.match(route, /if \(wanted\.length\) \{/, "no listings is a valid ensure");
  assert.match(route, /restaurant_name \?\? body\.name/);
});

test("the contract documents provision", () => {
  const doc = src("docs/crm-bridge-contract.md");
  assert.match(doc, /\/api\/crm\/restaurants\/:id\/provision/);
  assert.match(doc, /never resets/i);
});

console.log(`\n${passed} assertions passed.`);
