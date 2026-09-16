/**
 * The first run of a tablet at a store (Workstream I1).
 *
 * The restaurant touches nothing but the kiosk's own Wi-Fi button, which
 * Hexnode draws. Everything these assert is in service of that sentence:
 * which of the three screens a tablet shows and why, that the Ready
 * screen's ticks come from real state, that the offline page exists, is
 * served only when there is genuinely no network, and draws no Wi-Fi
 * control of its own - nothing in this app does.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KIOSK_WIFI_HINT,
  OFFLINE_FOOTER,
  READY_AUTO_ADVANCE_MS,
  allReady,
  firstRunScreen,
  offlineNotice,
  readyChecks,
} from "@/lib/first-run";
import { DEVICE_ID_KEY, DEVICE_REF_KEY, RESTAURANT_KEY, SETUP_DONE_KEY } from "@/lib/kiosk-cache";

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

test("no session: pairing, whatever else is true", () => {
  assert.equal(firstRunScreen({ sessionValid: false, setupDone: false }), "pairing");
  assert.equal(firstRunScreen({ sessionValid: false, setupDone: true }), "pairing");
});

test("a session, first time on this device: ready; after that: orders", () => {
  assert.equal(firstRunScreen({ sessionValid: true, setupDone: false }), "ready");
  assert.equal(firstRunScreen({ sessionValid: true, setupDone: true }), "orders");
});

test("there is no Wi-Fi screen and no Wi-Fi control anywhere in the app", () => {
  // Nick, 2026-09-16, after the Hexnode call: the kiosk draws the Wi-Fi
  // button. A web page cannot join a network, and drawing a button that
  // pretends to would be the second copy of the kiosk's.
  assert.doesNotMatch(src("lib/first-run.ts"), /"wifi"/);
  for (const f of [
    "public/offline.html",
    "app/link/page.tsx",
    "components/ReadyScreen.tsx",
    "components/OrderDashboard.tsx",
    "components/AlertGate.tsx",
  ]) {
    const s = src(f);
    assert.doesNotMatch(s, /intent:|WIFI_SETTINGS|panel\.action\.WIFI|Choose Wi-Fi|type="password"|ssid/i, `${f} must not draw a Wi-Fi control`);
  }
  assert.throws(() => src("lib/wifi.ts"), "lib/wifi.ts is gone");
});

console.log("\nthe three checks:");

test("each tick is a fact, and an unknown fact is not a tick", () => {
  const rows = readyChecks({ online: true, alertsOn: null, printer: { online: null } });
  assert.deepEqual(
    rows.map((r) => [r.key, r.ok]),
    [
      ["online", true],
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
    ["online", "alerts"]
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

test("a red row says what to do, in the restaurant's words - and points at the kiosk's button", () => {
  const rows = readyChecks({ online: false, alertsOn: false, printer: { online: false } });
  for (const r of rows) assert.ok(r.action, `${r.key} needs an action`);
  assert.equal(rows[0].action, KIOSK_WIFI_HINT);
  assert.equal(KIOSK_WIFI_HINT, "To change networks, use the Wi-Fi button at the bottom of the screen.");
  assert.match(rows[1].action!, /Turn on alerts/);
});

test("it moves on by itself, after long enough to read it", () => {
  assert.equal(READY_AUTO_ADVANCE_MS, 20_000);
  const ready = src("components/ReadyScreen.tsx");
  assert.match(ready, /READY_AUTO_ADVANCE_MS/);
  assert.match(ready, /onDone\(\)/);
  // Its checks are read, not assumed: the printer from the bridge's own
  // view, alerts from the gate's hook, the network from the dashboard's connection.
  assert.match(ready, /fetch\("\/api\/dashboard\/status"/);
  assert.match(src("app/api/dashboard/status/route.ts"), /DEFAULT_THRESHOLDS\.deviceSilentMinutes/, "same threshold the office alarms on");
  assert.match(src("components/OrderDashboard.tsx"), /online=\{connection !== "down" && !stale\}/);
});

test("the test order button is the same order the office sends", () =>
  assert.match(src("components/ReadyScreen.tsx"), /fetch\("\/api\/dashboard\/test-order", \{ method: "POST" \}\)/));

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
  assert.ok(page.includes(`"${RESTAURANT_KEY}"`), "offline.html must read the restaurant");
  assert.equal(SETUP_DONE_KEY, "premium.setupDone");
  assert.equal(DEVICE_ID_KEY, "premium.device");
  assert.equal(DEVICE_REF_KEY, "premium.deviceRef");
  assert.match(src("components/OrderDashboard.tsx"), /writeRestaurantCache\(\{ id: restaurantId, name: restaurantName \}\)/);
});

test("it is self-contained and leaves by itself", () => {
  const page = src("public/offline.html");
  assert.doesNotMatch(page, /<link |<script src=|url\(/, "nothing fetched from anywhere");
  assert.match(page, /addEventListener\("online"/);
  assert.match(page, /location\.replace\("\/dashboard"\)/);
});

test("the copy points at the kiosk's Wi-Fi button and is honest about who has been told", () => {
  const page = src("public/offline.html");
  assert.ok(page.includes(KIOSK_WIFI_HINT), "the one line about networks names the kiosk's control");
  assert.equal(offlineNotice("6:39 PM"), "Not receiving orders — Wi-Fi is down · reconnecting since 6:39 PM");
  assert.equal(offlineNotice(null), "Not receiving orders — Wi-Fi is down · reconnecting");
  // "Premium has been notified" would be a claim about a check that fires
  // after fifteen silent minutes while orders arrive. Say what is true.
  assert.equal(OFFLINE_FOOTER, "If this lasts, Premium is told automatically.");
  assert.ok(page.includes(OFFLINE_FOOTER));
});

test("the dashboard keeps the orders on screen while offline, dimmed, with the same hint", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /className=\{`app-list\$\{offline \? " offline" : ""\}`\}/);
  assert.match(dash, /offlineNotice\(offlineSince \? clockLabel\(offlineSince, timezone\) : null\)/);
  assert.match(dash, /setOfflineSince\(\(s\) => s \?\? Date\.now\(\)\)/, "the clock does not restart on every render");
  assert.match(dash, /\{KIOSK_WIFI_HINT\}/);
  assert.match(src("app/globals.css"), /\.app-list\.offline \{ opacity/);
});

test("the login page is staff-only and nothing on the tablet points at it", () => {
  assert.match(src("app/login/page.tsx"), /Premium staff sign-in/);
  for (const f of ["app/link/page.tsx", "public/offline.html", "components/ReadyScreen.tsx", "components/AlertGate.tsx", "components/OrderDashboard.tsx"]) {
    assert.doesNotMatch(src(f), /href="\/login"|\/login\?/, `${f} must not send a restaurant to the login form`);
  }
});

console.log(`\n${passed} assertions passed.`);
