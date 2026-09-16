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
    alert_state: null,
    push_subscriptions: 2,
    shell_version: null,
    display_mode: "kitchen",
    user_agent: null,
    device_ref: null,
    device_seen_at: null,
    device_model: null,
    device_count: 0,
  });
});

test("the bound kiosk unit is named: the most recently seen one when a store runs two, never one from elsewhere", () => {
  // kiosk_devices (I1): the serial Hexnode put on the shell, or the
  // install's aid:<ANDROID_ID>. The CRM pushed the binding; this reads it
  // back so the console can say which physical unit is on which wall.
  const one = tabletStatus({
    expected: true, displayMode: "kitchen", heartbeat: null, pushSubscriptions: 0, now: NOW,
    kioskDevices: [{ device_ref: "R8YL42BJPSB", model: "SM-X133", last_seen_at: ago(120_000), bound_at: ago(86_400_000) }],
  });
  assert.equal(one.device_ref, "R8YL42BJPSB");
  assert.equal(one.device_model, "SM-X133");
  assert.equal(one.device_seen_at, ago(120_000));
  assert.equal(one.device_count, 1);
  const two = tabletStatus({
    expected: true, displayMode: "kitchen", heartbeat: null, pushSubscriptions: 0, now: NOW,
    kioskDevices: [
      { device_ref: "aid:0123abcd", model: null, last_seen_at: null },
      { device_ref: "R8YL42BJPSB", model: "SM-X133", last_seen_at: ago(60_000) },
      { device_ref: "OLDER000001", model: "SM-X133", last_seen_at: ago(3_600_000) },
    ],
  });
  assert.equal(two.device_ref, "R8YL42BJPSB", "the one that bootstrapped most recently");
  assert.equal(two.device_count, 3);
  // A unit that never bootstrapped is still a binding - named when alone.
  assert.equal(tabletStatus({ expected: true, displayMode: "kitchen", heartbeat: null, pushSubscriptions: 0, now: NOW, kioskDevices: [{ device_ref: "aid:0123abcd" }] }).device_ref, "aid:0123abcd");
  // The roster only hands over rows bound to a restaurant, never unbound ones.
  assert.match(src("lib/crm-roster.ts"), /from\("kiosk_devices"\)[\s\S]*\.not\("restaurant_id", "is", null\)/);
});

test("a full heartbeat comes through as-is", () => {
  const t = tabletStatus({
    expected: true,
    displayMode: "standard",
    heartbeat: { last_seen_at: ago(60_000), user_agent: "Mozilla/5.0 (Linux; Android 14)", push_subscribed: true, shell_version: 4, alert_state: "hidden" },
    pushSubscriptions: 1,
    now: NOW,
  });
  assert.equal(t.online, true);
  assert.equal(t.push_subscribed, true);
  assert.equal(t.alert_state, "hidden");
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
  assert.equal(t.alert_state, null);
  assert.equal(t.push_subscriptions, 0);
});

test("blocked comes through as the word, and anything else the column could not hold is null", () => {
  // "blocked" on a Hexnode kiosk is the notification policy missing - the
  // one alert state the office acts on from its own desk (migration 037).
  // The column's CHECK is the same four words; a value outside them never
  // reaches the CRM as a fifth state.
  const blocked = tabletStatus({ expected: true, displayMode: "kitchen", heartbeat: { last_seen_at: ago(0), push_subscribed: false, alert_state: "blocked" }, pushSubscriptions: 0, now: NOW });
  assert.equal(blocked.alert_state, "blocked");
  assert.equal(blocked.push_subscribed, false);
  const odd = tabletStatus({ expected: true, displayMode: "kitchen", heartbeat: { last_seen_at: ago(0), alert_state: "Blocked" }, pushSubscriptions: 0, now: NOW });
  assert.equal(odd.alert_state, null);
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
  const roster = src("lib/crm-roster.ts");
  assert.match(route, /shapeRestaurantRow\(r, ctx\)/);
  assert.match(roster, /tablet: tabletFor\(r, ctx\)/);
  assert.match(route, /latest_shell_version: minShellVersion\(\) \|\| null/);
  assert.match(roster, /from\("dashboard_heartbeats"\)/);
  assert.match(roster, /from\("push_subscriptions"\)/);
  const doc = src("docs/crm-bridge-contract.md");
  const section = doc.slice(doc.indexOf("### The tablet object"));
  assert.ok(section.length > 0, "the contract must have a tablet section");
  for (const field of ["expected", "last_seen_at", "online", "push_subscribed", "alert_state", "push_subscriptions", "shell_version", "display_mode", "user_agent", "device_ref", "device_seen_at", "device_model", "device_count", "latest_shell_version"]) {
    assert.match(section, new RegExp(`"?${field}"?`), `contract must document ${field}`);
  }
  assert.match(section, /never a guess/);
});

test("one restaurant reads the same as the roster - same select, same shaping, plus the shell floor", () => {
  // GET /api/crm/restaurants/:id (D1): a partner page asks about one
  // account without pulling the whole roster, and gets the identical row.
  const one = src("app/api/crm/restaurants/[id]/route.ts");
  assert.match(one, /export async function GET\(/);
  assert.match(one, /\.select\(RESTAURANT_SELECT\)/);
  assert.match(one, /loadRosterContext\(\[row\.id\]\)/);
  assert.match(one, /restaurant: shapeRestaurantRow\(row, ctx\)/);
  assert.match(one, /latest_shell_version: minShellVersion\(\) \|\| null/);
  assert.match(one, /status: 404/);
  // Behind the same key as every other CRM call.
  const get = one.slice(one.indexOf("export async function GET("), one.indexOf("export async function POST("));
  assert.match(get, /authorizeCrmWrite\(req\)/);
  assert.match(src("app/api/crm/restaurants/route.ts"), /\.select\(RESTAURANT_SELECT\)/);
  assert.match(src("docs/crm-bridge-contract.md"), /\| GET \| `\/api\/crm\/restaurants\/:id` \|/);
});

console.log(`\n${passed} assertions passed.`);
