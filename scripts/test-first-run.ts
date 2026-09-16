/**
 * The first run of a tablet at a store (Workstream I1).
 *
 * The restaurant's only setup step is Wi-Fi. Everything these assert is in
 * service of that one sentence: which of the four screens a tablet shows
 * and why, that the Ready screen's ticks come from real state, that the
 * offline page exists and is served only when there is genuinely no
 * network, and that the button on it asks Android - not a web page - to
 * join a network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OFFLINE_FOOTER,
  READY_AUTO_ADVANCE_MS,
  allReady,
  firstRunScreen,
  offlineNotice,
  readyChecks,
} from "@/lib/first-run";
import { WIFI_FALLBACK_PATH, wifiIntentUrl, wifiPanelUrl, wifiSettingsUrl } from "@/lib/wifi";
import { DEVICE_ID_KEY, RESTAURANT_KEY, SETUP_DONE_KEY } from "@/lib/kiosk-cache";

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

console.log("which screen:");

test("no network and never set up: the Wi-Fi screen", () =>
  assert.equal(firstRunScreen({ online: false, sessionValid: false, setupDone: false }), "wifi"));

test("no network on a tablet that HAS been set up is the offline state, not setup again", () => {
  // The Wi-Fi screen says "that's the only thing to set up"; a working
  // tablet whose router rebooted has nothing to set up.
  assert.notEqual(firstRunScreen({ online: false, sessionValid: true, setupDone: true }), "wifi");
});

test("a network and no session: pairing, whatever else is true", () => {
  assert.equal(firstRunScreen({ online: true, sessionValid: false, setupDone: false }), "pairing");
  assert.equal(firstRunScreen({ online: true, sessionValid: false, setupDone: true }), "pairing");
});

test("a network and a session, first time on this device: ready; after that: orders", () => {
  assert.equal(firstRunScreen({ online: true, sessionValid: true, setupDone: false }), "ready");
  assert.equal(firstRunScreen({ online: true, sessionValid: true, setupDone: true }), "orders");
});

console.log("\nthe three checks:");

test("each tick is a fact, and an unknown fact is not a tick", () => {
  const rows = readyChecks({ online: true, alertsOn: null, printer: { online: null } });
  assert.deepEqual(
    rows.map((r) => [r.key, r.ok]),
    [
      ["wifi", true],
      ["alerts", null],
      ["printer", null],
    ]
  );
  assert.equal(allReady(rows), false, "not ready while alerts are unknown");
});

test("a restaurant with no printer has no printer row - omitted, not ticked", () => {
  const rows = readyChecks({ online: true, alertsOn: true, printer: null });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["wifi", "alerts"]
  );
  assert.equal(allReady(rows), true);
});

test("a printer that is off does not hold the screen; alerts off does", () => {
  // Orders still show on the tablet without paper. They do not ring
  // without alerts.
  assert.equal(allReady(readyChecks({ online: true, alertsOn: true, printer: { online: false } })), true);
  assert.equal(allReady(readyChecks({ online: true, alertsOn: false, printer: { online: true } })), false);
  assert.equal(allReady(readyChecks({ online: false, alertsOn: true, printer: null })), false);
});

test("a red row says what to do, in the restaurant's words", () => {
  const rows = readyChecks({ online: false, alertsOn: false, printer: { online: false } });
  for (const r of rows) assert.ok(r.action, `${r.key} needs an action`);
  assert.match(rows[1].action!, /Turn on alerts/);
});

test("it moves on by itself, after long enough to read it", () => {
  assert.equal(READY_AUTO_ADVANCE_MS, 20_000);
  const ready = src("components/ReadyScreen.tsx");
  assert.match(ready, /READY_AUTO_ADVANCE_MS/);
  assert.match(ready, /onDone\(\)/);
  // Its checks are read, not assumed: the printer from the bridge's own
  // view, alerts from the gate's hook, Wi-Fi from the dashboard's connection.
  assert.match(ready, /fetch\("\/api\/dashboard\/status"/);
  assert.match(src("app/api/dashboard/status/route.ts"), /DEFAULT_THRESHOLDS\.deviceSilentMinutes/, "same threshold the office alarms on");
  assert.match(src("components/OrderDashboard.tsx"), /online=\{connection !== "down" && !stale\}/);
});

test("the test order button is the same order the office sends", () =>
  assert.match(src("components/ReadyScreen.tsx"), /fetch\("\/api\/dashboard\/test-order", \{ method: "POST" \}\)/));

console.log("\nthe Wi-Fi hand-off:");

test("the button asks Android for its picker; there is no web Wi-Fi form", () => {
  assert.equal(wifiIntentUrl("android.settings.WIFI_SETTINGS", null), "intent:#Intent;action=android.settings.WIFI_SETTINGS;end");
  assert.match(wifiPanelUrl("https://x.test"), /^intent:#Intent;action=android\.settings\.panel\.action\.WIFI;S\.browser_fallback_url=https%3A%2F%2Fx\.test%2Foffline\.html%3Fwifi%3Dunavailable;end$/);
  assert.match(wifiSettingsUrl(null), /WIFI_SETTINGS;end$/);
  for (const f of ["public/offline.html", "app/link/page.tsx", "components/ReadyScreen.tsx", "components/OrderDashboard.tsx"]) {
    assert.doesNotMatch(src(f), /type="password"|ssid/i, `${f} must not pretend to join a network`);
  }
});

test("a refused intent lands on a page that says so, not on a dead button", () => {
  assert.equal(WIFI_FALLBACK_PATH, "/offline.html?wifi=unavailable");
  const page = src("public/offline.html");
  assert.match(page, /wifi=unavailable/);
  assert.match(page, /can't open Wi-Fi settings from here/);
});

console.log("\nthe offline page:");

test("the worker serves it for navigations only, and only when the network fails", () => {
  const sw = src("public/sw.js");
  assert.match(sw, /if \(event\.request\.mode !== "navigate"\) return;/);
  assert.match(sw, /fetch\(event\.request\)\.catch\(/, "the browser's own fetch first; the cache only after it throws");
  assert.doesNotMatch(sw, /caches\.match\(event\.request\)/, "the app itself is never served from cache");
  assert.match(sw, /cache: "reload"/, "a new deploy's page is the one stored");
});

test("it reads the same keys the app writes", () => {
  const page = src("public/offline.html");
  for (const k of [RESTAURANT_KEY, SETUP_DONE_KEY]) assert.ok(page.includes(`"${k}"`), `offline.html must read ${k}`);
  assert.equal(DEVICE_ID_KEY, "premium.device");
  assert.match(src("components/OrderDashboard.tsx"), /writeRestaurantCache\(\{ id: restaurantId, name: restaurantName \}\)/);
});

test("it is self-contained and leaves by itself", () => {
  const page = src("public/offline.html");
  assert.doesNotMatch(page, /<link |<script src=|url\(/, "nothing fetched from anywhere");
  assert.match(page, /addEventListener\("online"/);
  assert.match(page, /location\.replace\("\/dashboard"\)/);
});

test("the copy: one thing to set up; and honest about who has been told", () => {
  const page = src("public/offline.html");
  assert.match(page, /Connect this tablet to your Wi-Fi/);
  assert.match(page, /That's the only thing to set up\./);
  assert.equal(offlineNotice("6:39 PM"), "Not receiving orders — Wi-Fi is down · reconnecting since 6:39 PM");
  assert.equal(offlineNotice(null), "Not receiving orders — Wi-Fi is down · reconnecting");
  // "Premium has been notified" would be a claim about a check that fires
  // after fifteen silent minutes while orders arrive. Say what is true.
  assert.equal(OFFLINE_FOOTER, "If this lasts, Premium is told automatically.");
  assert.ok(page.includes(OFFLINE_FOOTER));
});

test("the dashboard keeps the orders on screen while offline, dimmed", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /className=\{`app-list\$\{offline \? " offline" : ""\}`\}/);
  assert.match(dash, /offlineNotice\(offlineSince \? clockLabel\(offlineSince, timezone\) : null\)/);
  assert.match(dash, /setOfflineSince\(\(s\) => s \?\? Date\.now\(\)\)/, "the clock does not restart on every render");
  assert.match(src("app/globals.css"), /\.app-list\.offline \{ opacity/);
});

test("the login page is staff-only and nothing on the tablet points at it", () => {
  assert.match(src("app/login/page.tsx"), /Premium staff sign-in/);
  for (const f of ["app/link/page.tsx", "public/offline.html", "components/ReadyScreen.tsx", "components/AlertGate.tsx", "components/OrderDashboard.tsx"]) {
    assert.doesNotMatch(src(f), /href="\/login"|\/login\?/, `${f} must not send a restaurant to the login form`);
  }
});

console.log(`\n${passed} assertions passed.`);
