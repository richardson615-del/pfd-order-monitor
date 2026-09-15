/**
 * Assertions for a tablet taking new code on its own.
 *
 * The thing being protected is not "does it update" - it is that updating
 * never costs a kitchen an order. A reload destroys the AudioContext, and
 * browsers only let one be resumed from a user gesture, so a reload at the
 * wrong moment leaves a wall-mounted tablet silent with nobody near it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldReloadNow, updateAvailable } from "../lib/app-update";

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
const dash = src("components/OrderDashboard.tsx");
const route = src("app/api/version/route.ts");
const config = src("next.config.js");

console.log("noticing a new deployment:");

test("a different build id is an update", () => {
  assert.equal(updateAvailable("abc123", "def456"), true);
  assert.equal(updateAvailable("abc123", "abc123"), false);
});

test("a missing or malformed answer is never an update", () => {
  // Reloading on a bad response turns one broken deploy into a tablet reload
  // loop, on every screen at once.
  for (const bad of [undefined, null, "", 42, {}]) {
    assert.equal(updateAvailable("abc123", bad), false, String(bad));
  }
});

test("local development never reloads itself", () => {
  assert.equal(updateAvailable("dev", "dev"), false);
  assert.equal(updateAvailable("dev", "abc123"), false);
  assert.equal(updateAvailable("abc123", "dev"), false);
});

console.log("\nwhen it is allowed to actually reload:");

const quiet = { updateAvailable: true, waitingCount: 0, visible: true };

test("a quiet, visible screen with a new build reloads", () => {
  assert.equal(shouldReloadNow(quiet), true);
});

test("an order waiting blocks it, however old the code is", () => {
  // The reload would silence the in-page chime on a screen somebody needs
  // right now. A busy restaurant updates at the next quiet moment instead -
  // every restaurant has one.
  assert.equal(shouldReloadNow({ ...quiet, waitingCount: 1 }), false);
});

test("a hidden tab does not reload", () => {
  assert.equal(shouldReloadNow({ ...quiet, visible: false }), false);
});

test("no update means no reload, quiet or not", () => {
  assert.equal(shouldReloadNow({ ...quiet, updateAvailable: false }), false);
});

console.log("\nhow it is wired:");

test("the client's build id is inlined, and the route reports the running one", () => {
  // The comparison only works because one side is baked in at build time and
  // the other is read at request time from the CURRENT deployment.
  assert.match(config, /NEXT_PUBLIC_BUILD_ID: process\.env\.VERCEL_GIT_COMMIT_SHA/);
  assert.match(route, /VERCEL_GIT_COMMIT_SHA/);
});

test("the version check is never cached", () => {
  // A cached answer is a version check reporting what it was told last week.
  assert.match(route, /no-store/);
  assert.match(dash, /cache: "no-store"/);
});

test("a failed check does nothing at all", () => {
  // Bounded FORWARD from the fetch: there is an unrelated `void check()`
  // earlier in the file (the audio arming effect), and searching for it from
  // the start sliced backwards into an empty string - a test that passed on
  // nothing.
  const from = dash.indexOf('fetch("/api/version"');
  const check = dash.slice(from, dash.indexOf("setInterval(check, VERSION_CHECK_EVERY_MS)", from));
  assert.ok(from > -1 && check.length > 0, "the version check should be findable");
  assert.match(check, /catch \{/);
  // The CATCH block specifically must set nothing. The first version of this
  // asserted setNewBuild(true) never appeared before a catch, which is just
  // the shape of a try/catch and was always going to fail.
  const catchBlock = check.slice(check.indexOf("} catch {"));
  assert.doesNotMatch(catchBlock, /setNewBuild/);
});

test("the reload waits, so it cannot race a write in the same tick", () => {
  assert.match(dash, /setTimeout\(\(\) => window\.location\.reload\(\), 3_000\)/);
});

test("only the dashboard does this - never the order page", () => {
  // Reloading a ticket somebody is reading, mid-order, to get a new build is
  // exactly the trade this is meant to avoid.
  const viewer = src("components/OrderViewer.tsx");
  assert.doesNotMatch(viewer, /location\.reload/);
  assert.doesNotMatch(viewer, /api\/version/);
});

console.log(`\n${passed} assertions passed.`);
