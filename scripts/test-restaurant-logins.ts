/**
 * Restaurant logins over the CRM bridge.
 *
 * These are credentials, produced by somebody who is not sitting in this
 * app's own admin panel. The assertions here are about the two things that
 * makes non-negotiable: a login can only be touched through the restaurant it
 * actually belongs to, and every write leaves a record of who did it.
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
const route = src("app/api/crm/restaurants/[id]/logins/route.ts");
const migration = src("db/migrations/023_restaurant_login_audit.sql");

console.log("scoping:");

test("every verb is behind the bridge key", () => {
  const guards = route.match(/authorizeCrmWrite\(req\)/g) ?? [];
  assert.equal(guards.length, 3, "GET, POST and PATCH must each be authorised");
});

test("a reset only touches a login belonging to THAT restaurant", () => {
  // Without this a restaurant-scoped URL would reset any login in the system
  // given its username - not what the URL claims, and not what the audit row
  // would then describe.
  assert.match(route, /\.eq\("restaurant_id", restaurant\.id\)/);
  assert.match(route, /is not a login for/);
});

test("listing does not page-limit its way into being wrong", () => {
  // listUsers() pages at 50. On a screen answering "who can sign in here",
  // silently omitting someone is the worst way to be wrong.
  assert.match(route, /getUserById/);
  // The CALL, not the word - the comment above it explains why listUsers is
  // avoided, and a test that trips over its own explanation is pushing back
  // on documentation rather than behaviour.
  assert.doesNotMatch(route, /admin\.auth\.admin\.listUsers\(/);
});

console.log("\nauditing:");

test("both writes record who did it", () => {
  const audits = route.match(/await audit\(\{/g) ?? [];
  assert.equal(audits.length, 2, "create and reset must both be recorded");
  assert.match(route, /action: "created"/);
  assert.match(route, /action: "password_reset"/);
});

test("an unnamed actor is recorded as null, never guessed", () => {
  // The bridge authenticates with one shared key and cannot know who asked.
  assert.match(route, /actorOf/);
  assert.match(route, /: null/);
});

test("a failed audit does not block the write", () => {
  // An unwritable audit row is worth shouting about, not a reason to leave
  // somebody unable to sign a tablet in.
  const fn = route.slice(route.indexOf("async function audit"));
  assert.match(fn.slice(0, 900), /try \{/);
  assert.match(fn.slice(0, 900), /catch/);
});

test("the audit never stores the password", () => {
  // The row records that a change happened and who made it. Storing the value
  // would turn an audit trail into a second place credentials live.
  // A written FIELD, not the word: the action itself is called
  // "password_reset", so matching the bare word flags the thing being
  // recorded rather than the thing being stored.
  const fn = route.slice(route.indexOf("async function audit"), route.indexOf("const actorOf"));
  assert.doesNotMatch(fn, /password:/);
  assert.doesNotMatch(migration, /^\s*password\s/m);
});

test("deleting a restaurant does not erase its login history", () => {
  assert.match(migration, /on delete set null/);
  assert.match(migration, /username\s+text not null/);
});

console.log("\nwhat the responses say:");

test("a password is described as shown once and unrecoverable", () => {
  assert.match(route, /Shown once/);
  assert.match(route, /replaced, not recovered/);
});

test("a reset says it does not rescue a tablet already signed in", () => {
  // The consequence people would otherwise assume the opposite of.
  assert.match(route, /stays signed in until its session ends/);
});

test("a taken username says which part is taken", () => {
  // "already registered" about an address nobody typed is bewildering when
  // what you typed was a username.
  assert.match(route, /is already taken/);
  assert.match(route, /status: taken \? 409 : 400/);
});

console.log(`\n${passed} assertions passed.`);
