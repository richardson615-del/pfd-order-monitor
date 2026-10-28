/**
 * KT1 (prs-crm Ticket #779): the restaurant's own cook time and alerts.
 *
 * Worth asserting: the tablet sees only its own restaurant's findings, only
 * the allow-listed kinds, in the kitchen's words (no device names, no
 * other restaurant's name, no staff instructions); critical first; the
 * banner is the first critical; the cook time is one of the Accept quick
 * picks; and, by reading the routes, that both take the restaurant from the
 * session and the Store tab reads prep_minutes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COOK_TIME_CHOICES, kitchenAlertBanner, kitchenAlerts, parseCookTime } from "@/lib/kitchen-alerts";
import { READY_MINUTE_CHOICES } from "@/lib/ready-timer";
import type { HealthIssue } from "@/lib/health";

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

const R = "rest-1";
const issue = (key: string, over: Partial<HealthIssue> = {}): HealthIssue => ({
  key,
  severity: "critical",
  title: `staff title ${key}`,
  detail: "staff detail: Finish the printer's Direct Print setup, or deactivate the device.",
  restaurant_id: R,
  ...over,
});

console.log("alerts");

test("only this restaurant's findings, only the allow-listed kinds", () => {
  const out = kitchenAlerts(
    [
      issue("device_silent:dev-1", { device_id: "dev-1" }),
      issue("device_silent:dev-9", { restaurant_id: "rest-2" }),
      issue("order_unaccepted:o1"),
      issue("tablet_not_watching:rest-1"),
      issue("volume_low:rest-1", { severity: "warning" }),
      issue("cron_stale:poll", { restaurant_id: null }),
      issue("restaurant_no_device:rest-1", { severity: "warning" }),
    ],
    R
  );
  assert.deepEqual(out.map((a) => a.key), ["device_silent:dev-1", "restaurant_no_device:rest-1"]);
});

test("kitchen words, never the staff text", () => {
  const [a] = kitchenAlerts([issue("device_silent:dev-1", { title: "Printer offline: TM-m30III back", detail: "Willie Mae's - last checked in 2h ago." })], R);
  assert.equal(a!.title, "Printer offline - orders are not printing");
  assert.match(a!.detail, /power, its network cable and its paper/);
  assert.doesNotMatch(`${a!.title} ${a!.detail}`, /TM-m30III|Willie|Direct Print|deactivate/);
});

test("a print error keeps its plain-English title and names the order", () => {
  const [a] = kitchenAlerts([issue("job_failed:j1", { title: "Printer is out of paper: order 1196", order: { id: "o", order_number: "1196", received_at: null, age_minutes: null, customer_name: "X", total: 1, queued_by: null } })], R);
  assert.equal(a!.title, "Printer is out of paper: order 1196");
  assert.match(a!.detail, /Order 1196 did not print/);
  assert.doesNotMatch(a!.detail, /X/);
});

test("critical first, since from the monitor's stamp", () => {
  const out = kitchenAlerts([issue("restaurant_no_app_device:rest-1", { severity: "warning" }), issue("device_silent:d1")], R, new Map([["device_silent:d1", "2026-10-28T17:00:00Z"]]));
  assert.deepEqual(out.map((a) => a.severity), ["critical", "warning"]);
  assert.equal(out[0]!.since, "2026-10-28T17:00:00Z");
  assert.equal(out[1]!.since, null);
});

test("banner: null with no critical, the first critical otherwise, a count for more", () => {
  assert.equal(kitchenAlertBanner(kitchenAlerts([issue("restaurant_no_device:rest-1", { severity: "warning" })], R)), null);
  assert.equal(kitchenAlertBanner(kitchenAlerts([issue("device_silent:d1")], R)), "Printer offline - orders are not printing");
  assert.match(kitchenAlertBanner(kitchenAlerts([issue("device_silent:d1"), issue("job_stuck:j1", { title: "Ticket not printed: order 7" })], R))!, /\(and 1 more - see Store\)$/);
});

console.log("cook time");

test("the choices are Accept's quick picks", () => {
  assert.deepEqual([...COOK_TIME_CHOICES], [...READY_MINUTE_CHOICES]);
});

test("one of the picks is stored; anything else is refused in words", () => {
  assert.deepEqual(parseCookTime({ prep_minutes: 20 }), { kind: "ok", minutes: 20 });
  for (const bad of [{ prep_minutes: 21 }, { prep_minutes: "20" }, { prep_minutes: 0 }, {}, null]) {
    const d = parseCookTime(bad);
    assert.equal(d.kind, "error");
    if (d.kind === "error") assert.match(d.error, /Pick a cook time: 10, 15, 20, 25, 30, 45 minutes\./);
  }
});

console.log("routes");

test("both routes take the restaurant from the session, never the body", () => {
  for (const p of ["app/api/dashboard/alerts/route.ts", "app/api/dashboard/store/cook-time/route.ts"]) {
    const s = src(p);
    assert.match(s, /await storeSession\(\)/);
    assert.match(s, /s\.restaurantId/);
    assert.doesNotMatch(s, /restaurant_id\s*[:=]\s*body|body\.restaurant/);
  }
  assert.match(src("app/api/dashboard/store/cook-time/route.ts"), /update\(\{ prep_minutes: d\.minutes \}\)\.eq\("id", s\.restaurantId\)/);
  assert.match(src("app/api/dashboard/alerts/route.ts"), /i\.restaurant_id === s\.restaurantId/);
});

test("the Store read carries prep_minutes and the tab shows cook time and alerts", () => {
  assert.match(src("app/api/dashboard/store/route.ts"), /prep_minutes: prepMinutesOf\(r\.data\.prep_minutes\)/);
  const tab = src("components/StoreTab.tsx");
  assert.match(tab, /Default cook time/);
  assert.match(tab, /\/api\/dashboard\/store\/cook-time/);
  assert.match(tab, /<h3 className="store-h">Alerts<\/h3>/);
  assert.match(src("components/OrderDashboard.tsx"), /\/api\/dashboard\/alerts/);
});

console.log(`\n${passed} passed`);
