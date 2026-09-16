/**
 * The clock in the dashboard header, and the timezone that drives it.
 *
 * The tablet used to show its own device time - right exactly as often as
 * the Android timezone setting was, on tablets provisioned in Nashville and
 * shipped to eastern Kentucky. Migration 032 lets the CRM push each
 * restaurant's real zone. What is worth pinning: a bad zone is refused at
 * the bridge rather than stored, and a bad zone that somehow gets through
 * degrades to device time rather than to a blank header.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clockLabel, isValidTimeZone } from "@/lib/clock";

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

// 2026-09-15 13:52 UTC = 8:52 AM Central, 9:52 AM Eastern.
const NOW = Date.parse("2026-09-15T13:52:00Z");

console.log("a zone is either one the platform can render, or refused:");

test("real IANA names pass, including the Kentucky county zones", () => {
  for (const tz of [
    "America/Chicago",
    "America/New_York",
    "America/Kentucky/Louisville",
    "America/Kentucky/Monticello",
    "UTC",
  ]) {
    assert.equal(isValidTimeZone(tz), true, tz);
  }
});

test("abbreviations, typos, offsets and non-strings are refused", () => {
  for (const bad of ["CST", "Central", "America/Nashville", "+05:00", "", "  ", null, undefined, 42]) {
    assert.equal(isValidTimeZone(bad), false, String(bad));
  }
});

console.log("\nthe clock:");

test("it shows the restaurant's time when a zone is known", () => {
  assert.equal(clockLabel(NOW, "America/Chicago"), "8:52 AM");
  assert.equal(clockLabel(NOW, "America/New_York"), "9:52 AM");
});

test("null falls back to device time, which is what it did before", () => {
  const device = new Date(NOW).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  assert.equal(clockLabel(NOW, null), device);
  assert.equal(clockLabel(NOW, undefined), device);
});

test("a bad zone degrades to device time, never to a blank header", () => {
  const device = new Date(NOW).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  assert.equal(clockLabel(NOW, "America/Nashville"), device);
  assert.equal(clockLabel(NOW, "CST"), device);
});

console.log("\nthe bridge:");

test("the update endpoint validates with the same function the tablet renders with", () => {
  const route = src("app/api/crm/restaurants/[id]/route.ts");
  assert.match(route, /import \{ isValidTimeZone \} from "@\/lib\/clock"/);
  assert.match(route, /if \("timezone" in body\)/);
  assert.match(route, /updates\.timezone = null/, "null clears it");
  assert.match(route, /timezone must be an IANA zone name/, "a bad name is a 400, not a silent store");
});

test("what is writable is also returned - the console merges the response over its row", () => {
  const route = src("app/api/crm/restaurants/[id]/route.ts");
  const i = route.indexOf(".update(updates)");
  assert.ok(i > -1);
  const returned = route.slice(i, route.indexOf(".single()", i));
  assert.match(returned, /timezone/);
  assert.match(src("lib/crm-roster.ts"), /timezone: r\.timezone \?\? null/);
});

test("the dashboard reads it from the row and hands it to the clock", () => {
  assert.match(src("app/dashboard/page.tsx"), /"name, display_mode, timezone"/);
  assert.match(src("app/dashboard/page.tsx"), /timezone=\{restaurant\?\.timezone \?\? null\}/);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /clockLabel\(now, timezone\)/);
  assert.doesNotMatch(dash, /toLocaleTimeString/, "the header must not format its own time");
});

test("the setting cannot affect delivery, chiming or alerting", () => {
  // Same guarantee display_mode carries: presentation only.
  for (const f of ["lib/canonical.ts", "lib/kiosk.ts", "lib/health.ts", "lib/alerts.ts", "lib/push.ts"]) {
    assert.doesNotMatch(src(f), /\btimezone\b/, `${f} must not read timezone`);
  }
});

console.log(`\n${passed} assertions passed.`);
