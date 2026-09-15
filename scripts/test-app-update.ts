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
import {
  IDLE_BEFORE_RELOAD_MS,
  minShellVersion,
  readShellVersion,
  shellNeedsUpdate,
  shouldReloadNow,
  updateAvailable,
} from "../lib/app-update";

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
const heartbeat = src("app/api/dashboard/heartbeat/route.ts");
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

const quiet = { updateAvailable: true, waitingCount: 0, visible: true, idleMs: IDLE_BEFORE_RELOAD_MS };

test("a quiet, visible, untouched screen with a new build reloads", () => {
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

test("a screen touched in the last minute does not reload", () => {
  // "Nothing waiting" says nobody needs the screen. It does not say nobody
  // is using it - somebody reading the Done tab, or mid-tap.
  assert.equal(shouldReloadNow({ ...quiet, idleMs: IDLE_BEFORE_RELOAD_MS - 1 }), false);
  assert.equal(shouldReloadNow({ ...quiet, idleMs: 0 }), false);
  assert.equal(IDLE_BEFORE_RELOAD_MS, 60_000);
});

test("not measuring idleness is not the same as idle", () => {
  // A reload must be earned by evidence of quiet, not by the absence of it.
  assert.equal(shouldReloadNow({ ...quiet, idleMs: null }), false);
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

test("the version check rides the heartbeat, not a second timer", () => {
  // One request on a cadence that already exists. The beat's response
  // carries the serving build; the dashboard no longer asks /api/version.
  assert.match(heartbeat, /buildId: process\.env\.VERCEL_GIT_COMMIT_SHA \|\| "dev"/);
  assert.doesNotMatch(dash, /api\/version/);
  assert.doesNotMatch(dash, /VERSION_CHECK_EVERY_MS/);
  const beat = dash.slice(dash.indexOf('fetch("/api/dashboard/heartbeat"'));
  assert.match(beat.slice(0, 1500), /updateAvailable\(process\.env\.NEXT_PUBLIC_BUILD_ID/);
});

test("the version route is never cached", () => {
  // A cached answer is a version check reporting what it was told last week.
  assert.match(route, /no-store/);
});

test("a failed beat does nothing at all", () => {
  const from = dash.indexOf('fetch("/api/dashboard/heartbeat"');
  const beat = dash.slice(from, from + 1800);
  const catchBlock = beat.slice(beat.indexOf(".catch(() => {"));
  assert.ok(catchBlock.length > 0);
  assert.doesNotMatch(catchBlock.slice(0, 300), /setNewBuild|reload/);
});

test("the reload waits, so it cannot race a write in the same tick", () => {
  assert.match(dash, /setTimeout\(\(\) => window\.location\.reload\(\), 3_000\)/);
});

test("a reload that was not safe is tried again on the next beat", () => {
  // The decision effect depends on heartbeatOkAt, which changes every beat.
  assert.match(dash, /\}, \[newBuild, waiting\.length, heartbeatOkAt\]\);/);
});

test("idleness is measured from real touches, from the moment the page opened", () => {
  assert.match(dash, /useRef<number>\(Date\.now\(\)\)/);
  assert.match(dash, /addEventListener\("pointerdown", touched/);
  assert.match(dash, /idleMs: Date\.now\(\) - lastTouchRef\.current/);
});

test("the login page and the ticket reload only on return to the foreground, never on a timer", () => {
  // These pages have no heartbeat and no "quiet" to measure, but they have
  // one honest moment: coming back from being backgrounded. A ticket
  // somebody is reading is not reloaded to get new code.
  const hook = src("lib/use-fresh-build.ts");
  assert.match(hook, /visibilitychange/);
  assert.doesNotMatch(hook, /setInterval|setTimeout/);
  assert.match(hook, /if \(!canReload\(\)\) return;/);
  const viewer = src("components/OrderViewer.tsx");
  assert.match(viewer, /useFreshBuildOnReturn\(idle\)/);
  assert.doesNotMatch(viewer, /location\.reload|api\/version/);
  const login = src("app/login/page.tsx");
  assert.match(login, /useFreshBuildOnReturn\(untouched\)/);
  assert.match(login, /username === "" && password === ""/, "a form somebody started typing into wins");
});

console.log("\nthe Android shell, which the web cannot update:");

test("the shell says which build it is on the startUrl, and the page remembers it", () => {
  const twa = JSON.parse(src("android/twa-manifest.json"));
  assert.equal(twa.startUrl, `/dashboard?shell=${twa.appVersionCode}`);
  assert.equal(readShellVersion("https://x/dashboard?shell=4", null), 4);
  // The login redirect nests the dashboard URL inside ?next=, encoded.
  assert.equal(readShellVersion("https://x/login?next=%2Fdashboard%3Fshell%3D4", null), 4);
  assert.equal(readShellVersion("https://x/dashboard", "4"), 4, "remembered when the URL no longer says");
  assert.equal(readShellVersion("https://x/dashboard", null), null, "unknown is null, never zero");
  assert.equal(readShellVersion("https://x/dashboard?shell=abc", "junk"), null);
  assert.match(src("app/login/page.tsx"), /rememberShellVersion\(\)/, "the signed-out tablet lands on login first");
});

test("a shell below the office's minimum is an amber line, never a block, never a download", () => {
  assert.equal(shellNeedsUpdate(3, 4), true);
  assert.equal(shellNeedsUpdate(4, 4), false);
  assert.equal(shellNeedsUpdate(null, 4), false, "unknown is not old");
  assert.equal(shellNeedsUpdate(3, 0), false, "no opinion means no line");
  assert.equal(shellNeedsUpdate(3, "4"), false, "a malformed minimum is no opinion");
  assert.match(dash, /shellNeedsUpdate\(shellVersion, minShell\)/);
  assert.match(dash, /needs an update from Premium/);
  assert.doesNotMatch(dash, /install\.html|download/i);
  assert.doesNotMatch(src("components/AlertGate.tsx"), /install\.html/, "restaurants are never sent to the install page");
  assert.doesNotMatch(src("lib/print-document.ts"), /install\.html/);
});

test("the minimum comes from the environment, and the heartbeat records the shell", () => {
  assert.equal(minShellVersion({ MIN_SHELL_VERSION: "4" } as any), 4);
  assert.equal(minShellVersion({} as any), 0);
  assert.equal(minShellVersion({ MIN_SHELL_VERSION: "x" } as any), 0);
  assert.match(route, /minShellVersion: minShellVersion\(\)/);
  assert.match(heartbeat, /shell_version: shellVersion/);
  assert.match(heartbeat, /Number\.isInteger\(body\?\.shellVersion\)/, "only a sane integer is recorded; anything else is null, not zero");
  assert.match(src("db/migrations/033_heartbeat_shell_version.sql"), /add column if not exists shell_version integer/);
  assert.match(src("lib/expected-migrations.ts"), /033_heartbeat_shell_version\.sql/);
});

test("the build script names the file by the same number the shell reports", () => {
  const sh = src("android/build-apk.sh");
  assert.match(sh, /premium-orders-\$CODE\.apk/);
  assert.match(sh, /twa-manifest\.json/);
});

console.log(`\n${passed} assertions passed.`);
