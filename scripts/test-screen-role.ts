/**
 * Partner portal A2: the app on a computer and a phone, as well as the
 * kitchen tablet. Worth asserting: the tablet stays a kitchen screen whenever
 * anything says it is one (the shell, a device reference) or nothing says it
 * is not; a laptop or a phone is a remote screen; a person's choice wins; a
 * remote screen is never shown the alert gate and its heartbeat is never
 * recorded; and the nav renders the same tabs on all three.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { screenRole, PHONE_MAX_SHORT_SIDE } from "@/lib/screen-role";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
}
const src = (p: string) => readFileSync(p, "utf8");
const base = { shellVersion: null, deviceRef: null, pointerFine: false, shortSide: 800, chosen: null };

console.log("screen role");

test("the tablet stays a kitchen screen", () => {
  assert.equal(screenRole({ ...base, shellVersion: 7, pointerFine: true }), "kitchen");
  assert.equal(screenRole({ ...base, deviceRef: "aid:abcd1234", shortSide: 400 }), "kitchen");
  // A tablet in plain Chrome: a finger and a big screen.
  assert.equal(screenRole(base), "kitchen");
});

test("a laptop and a phone are remote screens", () => {
  assert.equal(screenRole({ ...base, pointerFine: true, shortSide: 900 }), "remote");
  assert.equal(screenRole({ ...base, shortSide: 390 }), "remote");
  assert.equal(screenRole({ ...base, shortSide: PHONE_MAX_SHORT_SIDE }), "kitchen");
});

test("a person's choice wins either way; junk is ignored", () => {
  assert.equal(screenRole({ ...base, shellVersion: 7, chosen: "remote" }), "remote");
  assert.equal(screenRole({ ...base, pointerFine: true, chosen: "kitchen" }), "kitchen");
  assert.equal(screenRole({ ...base, pointerFine: true, chosen: "nope" }), "remote");
});

console.log("wiring");

test("the gate only shows on a kitchen screen, and both gates offer the way out", () => {
  const d = src("components/OrderDashboard.tsx");
  assert.match(d, /role !== "kitchen" \? null : firstRun === true/);
  assert.match(d, /remote: role === "remote"/);
  assert.match(d, /if \(role === null\) return;/);
  assert.match(src("components/AlertGate.tsx"), /onRemote && <RemoteLink/);
  assert.match(src("components/ReadyScreen.tsx"), /onRemote && <RemoteLink/);
});

test("the server answers a remote beat but never records it", () => {
  const r = src("app/api/dashboard/heartbeat/route.ts");
  const at = r.indexOf("body?.remote === true");
  assert.ok(at > 0);
  assert.ok(at < r.indexOf('.from("dashboard_heartbeats")\n    .upsert'), "the remote check comes before the write");
});

test("one nav for three screens, every tab in it", () => {
  const d = src("components/OrderDashboard.tsx");
  for (const k of ["orders", "completed", "past", "stats", "menu", "money", "store"]) assert.match(d, new RegExp(`key: "${k}"`));
  const css = src("app/globals.css");
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.app\[data-display\] \.app-tabs \{\s*position: fixed/);
  assert.match(css, /@media \(min-width: 1100px\) and \(hover: hover\) and \(pointer: fine\)/);
});

console.log(`\n${passed} passed`);
