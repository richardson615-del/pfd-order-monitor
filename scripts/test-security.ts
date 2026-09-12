/**
 * Findings from the 2026-09-11 security review, pinned so they stay fixed.
 *
 * Nick asked for a review of everything after the first tablet went live in a
 * restaurant. Four things came out of it, and each has assertions here. The
 * point is not that these particular lines are right; it is that the same
 * class of mistake gets caught next time instead of re-found by reading.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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

/**
 * The same file with comments stripped.
 *
 * Three assertions in the first draft of this file failed against prose - one
 * of them against a comment that deliberately quotes the vulnerable line it
 * had just replaced. A security test that cannot tell code from an
 * explanation of code gets deleted, or worse, gets the explanation deleted.
 */
const code = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "");

const migrations = readdirSync(new URL("../db/migrations/", import.meta.url))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const allSql = [src("db/schema.sql"), ...migrations.map((f) => src(`db/migrations/${f}`))].join("\n");

console.log("the stored tablet password is not readable by a tablet:");

test("SELECT on the password column is revoked from client roles", () => {
  // THE FINDING. Migration 026 stored the password and claimed the table was
  // "RLS on with no policies". It is not - db/schema.sql grants:
  //   restaurant_users_select ... using (is_admin() or belongs_to_restaurant(..))
  // so every signed-in restaurant session could read its own rows, and since
  // 026 those rows held the password in plain text. Anyone who could reach a
  // browser console on a signed-in kiosk could ask PostgREST for it.
  //
  // RLS cannot express the fix: a policy admits or denies a ROW, and every
  // other column on these rows is legitimately visible to that restaurant.
  const revoke =
    /revoke select \([^)]*password_current[^)]*\)\s*on restaurant_users from [^;]*anon[^;]*authenticated/i;
  assert.match(allSql, revoke, "password_current must be revoked from anon and authenticated");
});

test("RLS being enabled is not mistaken for protecting a column", () => {
  // test-schema-check.ts asserts every table has RLS enabled. That check
  // passed for the whole window this hole was open, because RLS *was*
  // enabled - it simply does not do what 026's comment claimed. Stated where
  // the next person adding a sensitive column will read it.
  assert.match(
    src("db/migrations/027_password_column_not_readable_by_clients.sql"),
    /RLS alone does NOT protect it/
  );
});

console.log("\nshared secrets:");

test("the monitor endpoint fails closed when its secret is unset", () => {
  // It failed OPEN. `Bearer ${process.env.CRON_SECRET}` with the variable
  // unset is the literal string "Bearer undefined", so sending exactly that
  // header authenticated - to an endpoint that sends SMS.
  const route = code("app/api/monitor/check/route.ts");
  assert.doesNotMatch(route, /!==\s*`Bearer \$\{process\.env\.CRON_SECRET\}`/);
  assert.match(route, /if \(!expected\)/);
  assert.match(route, /status: 503/);
});

test("every shared secret is compared in constant time", () => {
  // constantTimeEquals already existed here and was used by exactly one of
  // the three shared-secret checks. One helper with one caller is not a
  // convention, it is an accident waiting to be repeated.
  for (const f of [
    "lib/crm-auth.ts",
    "app/api/monitor/check/route.ts",
    "app/api/ingest/zuppler/route.ts",
  ]) {
    assert.match(code(f), /constantTimeEquals\(/, `${f} must not compare a secret with === or !==`);
  }
});

test("the webhook refuses everything when its secret is unset", () => {
  // The guard that was already right, kept: a missing secret denies rather
  // than comparing the presented token against undefined.
  assert.match(code("app/api/ingest/zuppler/route.ts"), /!!secret &&/);
});

console.log("\nthe Android app:");

const manifest = src("android/app/src/main/AndroidManifest.xml");

test("the app's data cannot be copied off the tablet", () => {
  // bubblewrap generates allowBackup="true". The app's data is a signed-in
  // restaurant session on a device left switched on in a public-facing room,
  // and adb backup or Google cloud backup would copy it. A kiosk that signs
  // in once has no use for either.
  //
  // This also catches `bubblewrap update` regenerating the manifest back to
  // the default, which would silently undo it.
  assert.match(manifest, /android:allowBackup="false"/);
  assert.doesNotMatch(manifest, /android:allowBackup="true"/);
  // Android 12+ reads dataExtractionRules; older versions read the two flags.
  assert.match(manifest, /android:dataExtractionRules=/);
  assert.match(
    src("android/app/src/main/res/xml/data_extraction_rules.xml"),
    /<exclude domain="root"/
  );
});

test("it asks for no permission beyond internet and notifications", () => {
  // This reads the SOURCE manifest. The built APK also carries
  // com.pfdworks.orders.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION, which
  // AndroidX injects for its own runtime receivers - it is scoped to this
  // package's own signature and grants nothing outside the app. Verified with
  // `aapt2 dump badging` on the release APK rather than assumed.
  const perms = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    perms.sort(),
    ["android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS"],
    "a wrapper around a website has no business asking for anything else"
  );
});

test("it is not debuggable and does not permit cleartext", () => {
  // Neither is set, which is already correct - both default to false for a
  // release build. Asserted so that adding either cannot pass unnoticed.
  assert.doesNotMatch(manifest, /android:debuggable="true"/);
  assert.doesNotMatch(manifest, /android:usesCleartextTraffic="true"/);
});

console.log("\nsecrets reach neither the repository nor a log:");

test("the signing key is ignored, not committed", () => {
  const ignore = src("android/.gitignore");
  for (const pattern of ["*.keystore", "*.jks", "keystore-password.txt"]) {
    assert.ok(ignore.includes(pattern), `${pattern} must be ignored`);
  }
});

test("the build script never echoes the signing password", () => {
  // The VALUE, not the word. The script legitimately prints the PATH of the
  // password file when it is missing, which is how somebody fixes that.
  for (const line of src("android/build-apk.sh").split(/\r?\n/)) {
    if (!/^\s*echo\b/.test(line)) continue;
    assert.doesNotMatch(line, /\$PW\b|\$\{PW\}/, `echoes the password: ${line.trim()}`);
    // An EXPANSION of those variables. The script prints their NAMES in the
    // help text for when the password file is missing, which is the whole
    // point of that message.
    assert.doesNotMatch(
      line,
      /\$\{?BUBBLEWRAP_\w*PASSWORD/,
      `echoes the password: ${line.trim()}`
    );
  }
});

test("a revealed password is never logged", () => {
  // The VARIABLE being passed, not the word appearing in a message. The
  // store-failure path deliberately reads "login password not stored for" and
  // logs the username beside it, which is the entire value of that line.
  for (const f of [
    "app/api/crm/restaurants/[id]/logins/route.ts",
    "app/api/admin/restaurant-users/route.ts",
  ]) {
    for (const call of code(f).match(/console\.(log|error|warn)\([^;]*\)/g) ?? []) {
      const args = call.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
      assert.doesNotMatch(
        args,
        /\bpassword\b|password_current|\.password\b/,
        `${f}: ${call.slice(0, 90)}`
      );
    }
  }
});

console.log(`\n${passed} assertions passed.`);
