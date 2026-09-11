/**
 * Usernames for restaurant logins.
 *
 * Supabase identifies a user by email and a kitchen does not have one. The
 * address is derived from the username, which makes that derivation load
 * bearing in a way worth pinning: the address IS the account's identity, so a
 * change to how it is built orphans every restaurant login at once.
 */
import assert from "node:assert/strict";
import {
  MIN_PASSWORD_LENGTH,
  USERNAME_DOMAIN,
  emailToUsername,
  generatePassword,
  isDerivedEmail,
  isValidUsername,
  normaliseUsername,
  usernameToEmail,
} from "@/lib/usernames";

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

console.log("deriving the address:");

test("a username becomes an address under the one domain", () =>
  assert.equal(usernameToEmail("swezeys"), `swezeys@${USERNAME_DOMAIN}`));

test("it round-trips", () => {
  assert.equal(emailToUsername(usernameToEmail("china.one")), "china.one");
  assert.equal(isDerivedEmail(usernameToEmail("china.one")), true);
});

test("a real email passes straight through", () => {
  // Admins and anyone from before usernames have genuine addresses, and they
  // must keep working. This is why it is a function and not concatenation at
  // every call site.
  assert.equal(usernameToEmail("nick@pfdworks.com"), "nick@pfdworks.com");
  assert.equal(emailToUsername("nick@pfdworks.com"), null);
  assert.equal(isDerivedEmail("nick@pfdworks.com"), false);
});

test("case and stray spaces cannot make a second account", () => {
  // Typed on a tablet keyboard by somebody in a hurry. "Swezeys" failing to
  // match "swezeys" is a support call nobody should have to make.
  assert.equal(usernameToEmail("  SWEZEYS "), usernameToEmail("swezeys"));
  assert.equal(normaliseUsername(" ChIna.One "), "china.one");
});

console.log("\nwhat a username may be:");

test("ordinary ones are accepted", () => {
  for (const u of ["swezeys", "china.one", "torinos-2", "ariella_bistro", "ab"]) {
    assert.ok(isValidUsername(u), `${u} should be valid`);
  }
});

test("the ones that would cause trouble are not", () => {
  for (const u of [
    "",            // nothing
    "a",           // too short to be distinct
    "Swezeys",     // uppercase - normalise first, do not accept raw
    "swez eys",    // a space, unenterable reliably on a tablet
    ".leading",    // leading punctuation
    "a".repeat(32) // beyond the cap
  ]) {
    assert.equal(isValidUsername(u), false, `${JSON.stringify(u)} should be rejected`);
  }
});

console.log("\ngenerated passwords:");

const fakeRandom = (n: number) => Uint8Array.from({ length: n }, (_, i) => i * 7);

test("it is long enough for Supabase and short enough to thumb in", () => {
  // Three groups of four, down from four of five. 23 characters was a real
  // obstacle at the one moment this gets typed - somebody standing in a
  // kitchen holding a tablet - and the extra length was buying strength
  // against an attack that does not exist here: there is no offline hash to
  // grind, and Supabase rate-limits the login itself. Since migration 026 the
  // CRM can show it again, so a mistyped transcription is not a reset either.
  const p = generatePassword(fakeRandom);
  assert.ok(p.length >= MIN_PASSWORD_LENGTH);
  assert.equal(p.split("-").length, 3, "three groups, so it can still be read down a phone");
  assert.equal(p.replace(/-/g, "").length, 12);
});

test("no character anyone would misread", () => {
  // Same reasoning as the printer device keys: this gets written on a sticky
  // note and typed by somebody who did not choose it.
  const p = generatePassword((n) => Uint8Array.from({ length: n }, (_, i) => i));
  assert.doesNotMatch(p, /[l1IO0]/);
});

test("two calls do not produce the same password", () => {
  let seed = 0;
  const rnd = (n: number) => Uint8Array.from({ length: n }, () => (seed++ * 31) % 251);
  assert.notEqual(generatePassword(rnd), generatePassword(rnd));
});

console.log(`\n${passed} assertions passed.`);
