/**
 * Assertions for signing in.
 *
 * Every way this could fail used to end identically: back on the login form,
 * no session, no explanation. Three unrelated problems - a link carrying no
 * code, an expired code, and an address that was never invited - were
 * indistinguishable from each other and from "it just didn't work".
 *
 * None of them can be fixed by the person clicking the link, so what is
 * tested here is that each says what happened and who can fix it.
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
const callback = src("app/auth/callback/route.ts");
const login = src("app/login/page.tsx");

console.log("the callback no longer fails silently:");

test("a failed exchange does NOT continue to the dashboard", () => {
  // The original bug in one line: it redirected to `next` whatever happened,
  // so a dead link produced a bounce through middleware back to /login.
  assert.match(callback, /const \{ error \} = await supabase\.auth\.exchangeCodeForSession\(code\)/);
  assert.match(callback, /if \(error\)/);
});

test("a link with no code says so, instead of pretending it worked", () => {
  assert.match(callback, /if \(!code\)/);
  assert.match(callback, /didn't carry a sign-in code/);
});

test("it names both real causes of a missing code", () => {
  // A URL fragment never reaches a server, and a missing allowlist entry makes
  // Supabase substitute the Site URL. The user cannot tell these apart, so
  // the message names both rather than guessing.
  assert.match(callback, /Redirect URLs allowlist/);
  assert.match(callback, /invited rather than signed up/);
});

test("an expired link says expired, not a code", () => {
  assert.match(callback, /expired or was already used/);
});

test("Supabase's own refusal is read from the query string", () => {
  // It reports a refused link by redirecting WITH an error param, not by
  // failing the request - so nothing surfaces unless this is read.
  assert.match(callback, /error_description/);
});

test("every failure lands on the form with something to read", () => {
  assert.match(callback, /function fail\(/);
  assert.match(callback, /url\.searchParams\.set\("error", reason\)/);
});

console.log("\nthe login form:");

test("it shows what the callback could not do", () => {
  assert.match(login, /useState<string \| null>\(params\.get\("error"\)\)/);
});

test("it cannot create an account for an address nobody invited", () => {
  // The cause of the original report. Left at its default, signInWithOtp
  // creates a user for any address typed in - and a NEW user gets a "confirm
  // your email" rather than a sign-in link, which lands back on this form
  // having quietly made an account belonging to no restaurant.
  assert.match(login, /shouldCreateUser: false/);
});

test("'signups not allowed' is translated into who can fix it", () => {
  assert.match(login, /signups\? not allowed/i);
  assert.match(login, /hasn't been set up yet/);
  assert.match(login, /Ask PFD/);
});

console.log(`\n${passed} assertions passed.`);
