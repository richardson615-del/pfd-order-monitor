/**
 * What the bridge tells the CRM about a restaurant's tablet.
 *
 * The rule worth pinning is the negative one: nothing here is ever
 * fabricated. A missing heartbeat row is nulls and false, not a guess; a
 * heartbeat that never said whether it can ring is null, not false; a
 * shell that never said which it is is null, not zero.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TABLET_ONLINE_WITHIN_MS, tabletOnline, tabletStatus } from "@/lib/tablet-status";
import { HEARTBEAT_EVERY_MS } from "@/lib/kiosk";

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
const NOW = Date.parse("2026-09-15T16:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

console.log("online:");

test("a beat inside the window is online; at the boundary still online; past it not", () => {
  assert.equal(tabletOnline(ago(0), NOW), true);
  assert.equal(tabletOnline(ago(TABLET_ONLINE_WITHIN_MS), NOW), true);
  assert.equal(tabletOnline(ago(TABLET_ONLINE_WITHIN_MS + 1), NOW), false);
});

test("the window allows one missed beat and is shorter than the alarm", () => {
  // Two beats plus jitter. Health's tablet_not_watching waits 15 minutes to
  // raise an alarm; a status dot that lagged that long is one nobody trusts.
  assert.ok(TABLET_ONLINE_WITHIN_MS >= 2 * HEARTBEAT_EVERY_MS);
  assert.ok(TABLET_ONLINE_WITHIN_MS < 15 * 60_000);
  assert.equal(TABLET_ONLINE_WITHIN_MS, 5 * 60_000);
});

test("never seen, or an unreadable timestamp, is offline - not an error", () => {
  assert.equal(tabletOnline(null, NOW), false);
  assert.equal(tabletOnline(undefined, NOW), false);
  assert.equal(tabletOnline("not a date", NOW), false);
});

console.log("\nthe shape, and what null means:");

test("no heartbeat row: every derived field is null or false, the counts are real", () => {
  const t = tabletStatus({ expected: true, displayMode: "kitchen", heartbeat: null, pushSubscriptions: 2, now: NOW });
  assert.deepEqual(t, {
    expected: true,
    last_seen_at: null,
    online: false,
    push_subscribed: null,
    push_subscriptions: 2,
    shell_version: null,
    display_mode: "kitchen",
    user_agent: null,
  });
});

test("a full heartbeat comes through as-is", () => {
  const t = tabletStatus({
    expected: true,
    displayMode: "standard",
    heartbeat: { last_seen_at: ago(60_000), user_agent: "Mozilla/5.0 (Linux; Android 14)", push_subscribed: true, shell_version: 4 },
    pushSubscriptions: 1,
    now: NOW,
  });
  assert.equal(t.online, true);
  assert.equal(t.push_subscribed, true);
  assert.equal(t.shell_version, 4);
  assert.equal(t.display_mode, "standard");
  assert.match(t.user_agent!, /Android/);
});

test("a heartbeat that never said is null, never false and never zero", () => {
  // An older client that does not send the field must not be written down
  // as having alerts off, or as being on shell 0.
  const t = tabletStatus({ expected: true, displayMode: "kitchen", heartbeat: { last_seen_at: ago(0) }, pushSubscriptions: 0, now: NOW });
  assert.equal(t.push_subscribed, null);
  assert.equal(t.shell_version, null);
  assert.equal(t.push_subscriptions, 0);
});

test("not expected is still reported truthfully, not blanked", () => {
  // A tablet somebody set up but the office never switched on is a fact
  // the console should be able to show, not hide.
  const t = tabletStatus({ expected: false, displayMode: null, heartbeat: { last_seen_at: ago(0), push_subscribed: true }, pushSubscriptions: 1, now: NOW });
  assert.equal(t.expected, false);
  assert.equal(t.online, true);
  assert.equal(t.display_mode, "kitchen", "an unknown mode reads as the loud one, same as the tablet itself");
});

console.log("\nthe contract:");

test("the roster carries tablet and latest_shell_version, computed here, never in the CRM", () => {
  const route = src("app/api/crm/restaurants/route.ts");
  assert.match(route, /tablet: tabletStatus\(\{/);
  assert.match(route, /latest_shell_version: minShellVersion\(\) \|\| null/);
  assert.match(route, /from\("dashboard_heartbeats"\)/);
  assert.match(route, /from\("push_subscriptions"\)/);
  const doc = src("docs/crm-bridge-contract.md");
  const section = doc.slice(doc.indexOf("### The tablet object"));
  assert.ok(section.length > 0, "the contract must have a tablet section");
  for (const field of ["expected", "last_seen_at", "online", "push_subscribed", "push_subscriptions", "shell_version", "display_mode", "user_agent", "latest_shell_version"]) {
    assert.match(section, new RegExp(`"?${field}"?`), `contract must document ${field}`);
  }
  assert.match(section, /never a guess/);
});

console.log(`\n${passed} assertions passed.`);
