/**
 * A tablet boots straight into its restaurant (Workstream I1, 1b).
 *
 * The shell hands the page a device reference; the bridge maps it to the
 * restaurant the CRM assigned; the page gets a session with nobody typing.
 * These pin the rules that hand out those sessions, and that the shell,
 * the page and the bridge agree on the one parameter that carries the
 * reference.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOOTSTRAP_MINT_MIN_INTERVAL_MS,
  BOOTSTRAP_POLL_MS,
  BOOTSTRAP_RATE_MAX,
  DEVICE_PARAM,
  bootstrapDecision,
  deviceRefKind,
  isDeviceRef,
  mayBootstrap,
  parseBindings,
  readDeviceRef,
} from "@/lib/device-binding";

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

const NOW = Date.parse("2026-09-16T18:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

console.log("the reference:");

test("a serial or an aid:<ANDROID_ID> is a reference; junk is not", () => {
  assert.equal(isDeviceRef("R52X30ABCDE"), true);
  assert.equal(isDeviceRef("aid:9774d56d682e549c"), true);
  assert.equal(isDeviceRef("abc"), false, "too short");
  assert.equal(isDeviceRef("has space"), false);
  assert.equal(isDeviceRef("x".repeat(129)), false);
  assert.equal(isDeviceRef(42), false);
});

test("the shell's two sources are told apart by the prefix, nothing else", () => {
  assert.equal(deviceRefKind("R52X30ABCDE"), "managed");
  assert.equal(deviceRefKind("aid:9774d56d682e549c"), "android_id");
});

test("the page reads exactly the parameter the shell writes", () => {
  assert.equal(DEVICE_PARAM, "device");
  assert.equal(readDeviceRef("https://x.test/dashboard?shell=5&device=R52X30ABCDE"), "R52X30ABCDE");
  assert.equal(readDeviceRef("https://x.test/dashboard?shell=5"), null);
  assert.equal(readDeviceRef("https://x.test/dashboard?device=bad%20ref"), null);
  const launcher = src("android/app/src/main/java/com/pfdworks/orders/LauncherActivity.java");
  assert.match(launcher, /DEVICE_PARAM = "device"/);
  assert.match(launcher, /DEVICE_REF_KEY = "device_ref"/);
  assert.match(launcher, /ANDROID_ID_PREFIX = "aid:"/);
  assert.match(launcher, /getApplicationRestrictions\(\)/, "1b-i: managed configuration first");
  assert.match(launcher, /Settings\.Secure\.ANDROID_ID/, "1b-ii: the install id when there is none");
  assert.doesNotMatch(launcher, /getSerial|Build\.SERIAL/, "the app never tries to read the hardware serial");
  assert.match(src("android/app/src/main/res/xml/app_restrictions.xml"), /android:key="device_ref"/);
  assert.match(src("android/app/src/main/AndroidManifest.xml"), /android\.content\.APP_RESTRICTIONS/);
});

test("the shell is one rebuild, code 5, same key", () => {
  const twa = JSON.parse(src("android/twa-manifest.json"));
  assert.equal(twa.appVersionCode, 5);
  assert.equal(twa.startUrl, "/dashboard?shell=5");
  assert.equal(twa.signingKey.alias, "pfd-orders");
  assert.match(src("android/app/build.gradle"), /versionCode 5/);
});

console.log("\nthe bootstrap:");

const row = (over: Record<string, unknown> = {}) => ({
  device_ref: "R52X30ABCDE",
  restaurant_id: "r1",
  last_bootstrap_at: null as string | null,
  ...over,
});

test("never seen, or seen and unassigned: unbound - and the page keeps asking", () => {
  assert.equal(bootstrapDecision(null, NOW), "unbound");
  assert.equal(bootstrapDecision(row({ restaurant_id: null }), NOW), "unbound");
  assert.equal(BOOTSTRAP_POLL_MS, 5_000);
});

test("assigned: bound, once per interval; a reload loop does not mint a session a second", () => {
  assert.equal(bootstrapDecision(row(), NOW), "bound");
  assert.equal(bootstrapDecision(row({ last_bootstrap_at: at(-BOOTSTRAP_MINT_MIN_INTERVAL_MS + 1000) }), NOW), "throttled");
  assert.equal(bootstrapDecision(row({ last_bootstrap_at: at(-BOOTSTRAP_MINT_MIN_INTERVAL_MS) }), NOW), "bound");
  assert.equal(bootstrapDecision(row({ last_bootstrap_at: "garbage" }), NOW), "bound", "an unreadable stamp does not lock a tablet out");
});

test("one address is capped per window - generously, because unbound tablets poll", () => {
  assert.equal(mayBootstrap(0), true);
  assert.equal(mayBootstrap(BOOTSTRAP_RATE_MAX), false);
  assert.ok(BOOTSTRAP_RATE_MAX >= 120, "an unbound tablet polling every 5 s for ten minutes is 120 calls");
});

test("the route logs every call, records the reference whatever the answer, and mints through the one helper", () => {
  const route = src("app/api/kiosk/bootstrap/route.ts");
  assert.match(route, /from\("kiosk_bootstrap_log"\)\.insert/);
  assert.match(route, /from\("kiosk_devices"\)\.upsert/);
  assert.match(route, /mintTabletSession\(restaurant/);
  assert.match(route, /status: "unbound"/);
  assert.match(route, /"Cache-Control": "no-store"/);
  // The link route mints the same way: one helper, one rule for which login.
  assert.match(src("app/api/crm/tablets/link/route.ts"), /mintTabletSession\(restaurant, actor\)/);
  const helper = src("lib/tablet-session.ts");
  assert.match(helper, /ensureTabletLogin\(restaurant, actor\)/);
  assert.match(helper, /generateLink\(\{ type: "magiclink"/);
});

test("the page bootstraps while a reference is known, and settles a session exactly once", () => {
  const page = src("app/link/page.tsx");
  assert.match(page, /fetch\("\/api\/kiosk\/bootstrap"/);
  assert.match(page, /rememberDeviceRef\(window\.location\.href\)/);
  assert.match(page, /if \(settling\.current\) return;/, "bootstrap and the link poll can both succeed; only one may verify");
  assert.match(page, /verifyOtp\(\{ token_hash: tokenHash, type: "magiclink" \}\)/);
  assert.match(src("components/OrderDashboard.tsx"), /rememberDeviceRef\(window\.location\.href\)/, "the dashboard remembers it too");
});

console.log("\nthe CRM's half:");

test("bindings are parsed strictly: one or many, null unbinds, junk refuses the whole call", () => {
  assert.deepEqual(parseBindings({ device_ref: "R52X30ABCDE", restaurant_id: "r1" }), [{ device_ref: "R52X30ABCDE", restaurant_id: "r1", model: null }]);
  assert.deepEqual(parseBindings({ bindings: [{ device_ref: "aid:abcdef1234567890", restaurant_id: null, model: "Galaxy Tab A9" }] }), [
    { device_ref: "aid:abcdef1234567890", restaurant_id: null, model: "Galaxy Tab A9" },
  ]);
  assert.equal(parseBindings({ bindings: [{ device_ref: "bad ref", restaurant_id: "r1" }] }), null);
  assert.equal(parseBindings({ bindings: [{ device_ref: "R52X30ABCDE", restaurant_id: 7 }] }), null);
  assert.equal(parseBindings({}), null);
  assert.equal(parseBindings(null), null);
});

test("bind is CRM-authenticated, refuses unknown restaurants by name, and upserts the rest", () => {
  const route = src("app/api/crm/tablets/bind/route.ts");
  assert.match(route, /authorizeCrmWrite\(req\)/);
  assert.match(route, /unknown_restaurants\.push/);
  assert.match(route, /upsert\(rows, \{ onConflict: "device_ref" \}\)/);
});

test("unbound lists what has called in and is assigned to nobody", () => {
  const route = src("app/api/crm/tablets/unbound/route.ts");
  assert.match(route, /authorizeCrmWrite\(req\)/);
  assert.match(route, /\.is\("restaurant_id", null\)/);
  assert.match(route, /UNBOUND_VISIBLE_MS/);
});

console.log(`\n${passed} assertions passed.`);
