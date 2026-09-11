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
const storeMigration = src("db/migrations/026_restaurant_login_password.sql");

/**
 * Just the reveal branch of GET.
 *
 * Delimited on the listing query's own comment rather than "const { data:
 * links }", which also appears inside findLink ABOVE the branch - slicing on
 * that produced an empty string, and two assertions passed against nothing.
 */
function revealBranch(): string {
  const start = route.indexOf("const reveal =");
  const end = route.indexOf("// getUserById per link");
  assert.ok(start > -1 && end > start, "could not isolate the reveal branch");
  return route.slice(start, end);
}

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

test("every write AND every reveal records who did it", () => {
  // Three now, not two. Reveal reads a credential, which is exactly what
  // migration 015 decided was worth recording - a stored password that could
  // be shown without a trace would be strictly worse than the one-shot
  // password it replaced.
  const audits = route.match(/await audit\(\{/g) ?? [];
  assert.equal(audits.length, 3, "create, reset and reveal must all be recorded");
  assert.match(route, /action: "created"/);
  assert.match(route, /action: "password_reset"/);
  assert.match(route, /action: "password_shown"/);
});

test("the audit table actually accepts a reveal", () => {
  // 023's CHECK allows only created/password_reset. Without widening it, every
  // reveal would fail to record while still returning the password - an audit
  // trail that is quietly partial, which is the worst state for one to be in.
  assert.match(storeMigration, /password_shown/);
  assert.match(storeMigration, /add constraint restaurant_login_audit_action_check/);
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

test("a new password says it can be shown again", () => {
  // The old copy said "Nothing can retrieve it". Leaving that in place while
  // the CRM grew a Show password button would have people resetting a working
  // login to recover a password they could simply have looked at - and a reset
  // breaks the next tablet that signs in with the sticky note.
  assert.match(route, /show it again/);
  assert.doesNotMatch(route, /replaced, not recovered/);
});

console.log("\nshowing a password again:");

test("reveal is a separate request, not a field on the list", () => {
  // Opening the panel to see WHO can sign in must not read a credential, or
  // the audit row stops meaning anything.
  assert.match(route, /searchParams\.get\("reveal"\)/);
  const listBlock = route.slice(route.indexOf("const logins = []"), route.indexOf("export async function POST"));
  assert.doesNotMatch(listBlock, /password_current,$/m);
  assert.match(listBlock, /has_password: Boolean\(/);
});

test("reveal is scoped to the restaurant in the URL", () => {
  // Same rule as reset: a restaurant-scoped route must not hand back a
  // password belonging to someone else because the username was spelled right.
  const revealBlock = revealBranch();
  assert.match(revealBlock, /findLink\(restaurant\.id, reveal\)/);
  assert.match(revealBlock, /is not a login for/);
});

test("reveal changes nothing", () => {
  // The whole point over "New password": recovering a lost password must not
  // invalidate the tablet still running on the old one.
  const revealBlock = revealBranch();
  assert.doesNotMatch(revealBlock, /updateUserById/);
  assert.doesNotMatch(revealBlock, /generatePassword/);
});

test("a login from before this feature says reset, not error", () => {
  // Its only copy is Supabase's hash. Saying so is the difference between a
  // usable instruction and a button that appears broken.
  assert.match(route, /before passwords were kept/);
  assert.match(route, /status: 409/);
});

test("the password is stored only after Supabase accepted it", () => {
  // Storing first would leave the CRM confidently showing a password that does
  // not work, which is worse than showing none at all.
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.ok(
    patch.indexOf("updateUserById") < patch.indexOf("password_current:"),
    "the update must precede the store"
  );
});

test("a failed store does not fail a password that did change", () => {
  // The new password is live and is in the response; erroring here would tell
  // the caller it had not worked when it had.
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.match(patch, /console\.error\("login password not stored/);
});

test("the column is service-role only", () => {
  assert.match(storeMigration, /restaurant_users/);
  assert.match(storeMigration, /password_current/);
  // The decision is recorded where the next person will look, rather than
  // reading as an oversight.
  assert.match(storeMigration, /Service role only/i);
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
