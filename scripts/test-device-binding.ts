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
  bindingMismatch,
  BOOTSTRAP_MINT_MIN_INTERVAL_MS,
  BOOTSTRAP_POLL_MS,
  BOOTSTRAP_RATE_MAX,
  DEVICE_PARAM,
  bootstrapDecision,
  bootstrapWaitReply,
  deviceRefKind,
  isDeviceRef,
  isDeviceSecret,
  isSecretHash,
  kioskRequireSecret,
  mayBootstrap,
  mayIssueSecretOnLink,
  parseBindings,
  readDeviceRef,
  secretsEndedByBind,
} from "@/lib/device-binding";
import { deviceSecretMatches, hashDeviceSecret, newDeviceSecret } from "@/lib/device-secret";
import { DEVICE_SECRET_FRAGMENT, DEVICE_SECRET_KEY, readSecretFragment } from "@/lib/kiosk-cache";

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

// Code 6 (SH1): the shell also hands over the device secret, so it is a new build.
test("the shell is one rebuild, code 6, same key", () => {
  const twa = JSON.parse(src("android/twa-manifest.json"));
  assert.equal(twa.appVersionCode, 6);
  assert.equal(twa.startUrl, "/dashboard?shell=6");
  assert.equal(twa.signingKey.alias, "pfd-orders");
  assert.match(src("android/app/build.gradle"), /versionCode 6/);
  assert.match(src("android/app/build.gradle"), /launchUrl: '\/dashboard\?shell=6'/);
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
  assert.match(route, /if \(decision !== "bound"\) return NextResponse\.json\(bootstrapWaitReply\(\)/);
  assert.equal(bootstrapWaitReply().status, "unbound");
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

// Elijah, 2026-10-23: a tablet moved from Greek Style Gyro to Teriyaki
// Madness in the CRM kept showing Greek Style, and there is no sign-out.
test("a tablet bound to another restaurant is told to re-bind; unbound or matching is left alone", () => {
  assert.equal(bindingMismatch("teriyaki", ["greek"]), true);
  assert.equal(bindingMismatch("teriyaki", []), true);
  assert.equal(bindingMismatch("greek", ["greek"]), false);
  assert.equal(bindingMismatch("greek", ["other", "greek"]), false);
  assert.equal(bindingMismatch(null, ["greek"]), false);
  assert.equal(bindingMismatch(undefined, ["greek"]), false);
});

test("the heartbeat carries the device and the answer; the dashboard signs out and re-boots on it", () => {
  const beat = src("app/api/dashboard/heartbeat/route.ts");
  assert.match(beat, /deviceMovedAway\(body\?\.deviceRef, restaurantIds\)/);
  assert.match(beat, /\.from\("kiosk_devices"\)/);
  // every reply carries it, the rate-limited one included
  assert.equal((beat.match(/rebind[,}\s]/g) ?? []).length >= 4, true);
  // only a yes/no leaves the server, never which restaurant it is bound to
  assert.doesNotMatch(beat, /bound_restaurant|rebind:\s*data/);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /deviceRef: readDeviceRefCache\(\)/);
  assert.match(dash, /data\?\.rebind === true/);
  assert.match(dash, /signOutAndRebind\(\)/);
  assert.match(dash, /auth\.signOut\(\)/);
  assert.match(dash, /window\.location\.assign\("\/link"\)/);
});

// ---------------------------------------------------------------------------
// SH1 / Z-02. The reference is printed on the tablet and shown in the CRM, and
// bootstrap is unauthenticated - so the reference alone must not be worth a
// restaurant's session.
// ---------------------------------------------------------------------------
console.log("\nthe device secret (SH1 / Z-02):");

const SECRET = "s3cr3t-for-this-tablet-AAAAAAAAAAAAAAAAAAAA";
const OTHER = "a-different-secret-entirely-BBBBBBBBBBBBBBBB";
const HASH = hashDeviceSecret(SECRET);

/** Exactly what the route does: hash what was presented, compare, hand the yes/no to the pure decision. */
const decide = (r: ReturnType<typeof row> | null, presented: unknown, env: Record<string, string | undefined>, now = NOW) =>
  bootstrapDecision(r, now, {
    requireSecret: kioskRequireSecret(env),
    secretMatches: deviceSecretMatches((r as { secret_hash?: string | null } | null)?.secret_hash, presented),
  });

const OFF = {};
const ON = { KIOSK_REQUIRE_SECRET: "1" };

test("the switch is off unless somebody sets it to 1 or true", () => {
  assert.equal(kioskRequireSecret({}), false, "unset = off: nothing changes on deploy");
  assert.equal(kioskRequireSecret({ KIOSK_REQUIRE_SECRET: "" }), false);
  assert.equal(kioskRequireSecret({ KIOSK_REQUIRE_SECRET: "0" }), false);
  assert.equal(kioskRequireSecret({ KIOSK_REQUIRE_SECRET: "false" }), false);
  assert.equal(kioskRequireSecret({ KIOSK_REQUIRE_SECRET: "off" }), false);
  assert.equal(kioskRequireSecret({ KIOSK_REQUIRE_SECRET: "1" }), true);
  assert.equal(kioskRequireSecret({ KIOSK_REQUIRE_SECRET: " TRUE " }), true);
});

test("a secret is 32 random bytes as url-safe text; only its sha256 is ever kept", () => {
  const a = newDeviceSecret();
  const b = newDeviceSecret();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.equal(isDeviceSecret(a), true);
  assert.equal(isDeviceSecret("short"), false);
  assert.equal(isDeviceSecret("has space " + "x".repeat(40)), false);
  assert.equal(isDeviceSecret(undefined), false);
  // sha256("abc"), the published vector: the hash is plain sha256 of the text, lowercase hex.
  assert.equal(hashDeviceSecret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(isSecretHash(HASH), true);
  assert.equal(isSecretHash(HASH.toUpperCase()), false);
  assert.equal(isSecretHash(SECRET), false, "a secret is not a hash: the CRM route cannot be handed one by mistake");
});

test("the comparison fails closed on everything that is not the right secret against a real hash", () => {
  assert.equal(deviceSecretMatches(HASH, SECRET), true);
  assert.equal(deviceSecretMatches(HASH, OTHER), false);
  assert.equal(deviceSecretMatches(HASH, undefined), false);
  assert.equal(deviceSecretMatches(HASH, null), false);
  assert.equal(deviceSecretMatches(HASH, ""), false);
  assert.equal(deviceSecretMatches(HASH, HASH), false, "knowing the stored hash is not knowing the secret");
  assert.equal(deviceSecretMatches(HASH, { toString: () => SECRET }), false);
  assert.equal(deviceSecretMatches(null, SECRET), false, "no hash on the row: nothing matches");
  assert.equal(deviceSecretMatches(undefined, SECRET), false);
  assert.equal(deviceSecretMatches("", SECRET), false);
  assert.equal(deviceSecretMatches("not-a-hash", SECRET), false);
  assert.match(src("lib/device-secret.ts"), /timingSafeEqual\(a, b\)/, "timing-safe, not ===");
  assert.doesNotMatch(src("lib/device-secret.ts"), /console\./, "nothing in the secret helper logs");
});

// missing / wrong / right secret  x  switch off / on  x  row with / without a secret_hash
test("the whole table: secret x switch x secret_hash", () => {
  const plain = row(); // bound, no secret_hash: every tablet on a wall today
  const keyed = row({ secret_hash: HASH });
  const table: [string, ReturnType<typeof row>, unknown, Record<string, string | undefined>, string][] = [
    ["no hash, off, missing", plain, undefined, OFF, "bound"],
    ["no hash, off, wrong", plain, OTHER, OFF, "bound"],
    ["no hash, off, right", plain, SECRET, OFF, "bound"],
    ["no hash, on, missing", plain, undefined, ON, "unbound"],
    ["no hash, on, wrong", plain, OTHER, ON, "unbound"],
    ["no hash, on, right", plain, SECRET, ON, "unbound"], // nothing to be right against
    ["hash, off, missing", keyed, undefined, OFF, "unbound"],
    ["hash, off, wrong", keyed, OTHER, OFF, "unbound"],
    ["hash, off, right", keyed, SECRET, OFF, "bound"],
    ["hash, on, missing", keyed, undefined, ON, "unbound"],
    ["hash, on, wrong", keyed, OTHER, ON, "unbound"],
    ["hash, on, right", keyed, SECRET, ON, "bound"],
  ];
  for (const [name, r, presented, env, want] of table) assert.equal(decide(r, presented, env), want, name);
  assert.equal(table.length, 12);
});

// The brief's acceptance line.
test("ACCEPTANCE: KIOSK_REQUIRE_SECRET=1, a known bound serial and no secret -> unbound, and no session is minted", () => {
  const known = row({ device_ref: "R52X30ABCDE", restaurant_id: "r1" });
  assert.equal(decide(known, undefined, { KIOSK_REQUIRE_SECRET: "1" }), "unbound");
  assert.equal(decide(row({ secret_hash: HASH }), undefined, { KIOSK_REQUIRE_SECRET: "1" }), "unbound");
  // "No session is minted": in the route, everything that is not `bound`
  // returns before the one place a session is made, and that return is the
  // only thing between the decision and the mint.
  const route = src("app/api/kiosk/bootstrap/route.ts");
  const decided = route.indexOf("const decision = bootstrapDecision(row, now, {");
  const gate = route.indexOf('if (decision !== "bound") return NextResponse.json(bootstrapWaitReply()');
  const mint = route.indexOf("mintTabletSession(");
  assert.ok(decided > 0 && gate > decided && mint > gate, "decide, then leave unless bound, then mint");
  assert.equal(route.split("mintTabletSession(").length - 1, 1, "one place mints");
  assert.match(route, /requireSecret: kioskRequireSecret\(\)/);
  assert.match(route, /secretMatches: deviceSecretMatches\(row\?\.secret_hash, body\?\.secret\)/);
});

// Safety 1: nothing in production changes until somebody sets a secret or flips the switch.
test("switch off and no secret_hash: every answer is what it was before 067, whatever is sent", () => {
  const rows = [
    null,
    row({ restaurant_id: null }),
    row(),
    row({ last_bootstrap_at: at(-1000) }),
    row({ last_bootstrap_at: at(-BOOTSTRAP_MINT_MIN_INTERVAL_MS) }),
    row({ last_bootstrap_at: "garbage" }),
    row({ secret_hash: null }),
  ];
  for (const r of rows) {
    const before = bootstrapDecision(r, NOW); // the two-argument call every existing caller and test makes
    for (const presented of [undefined, OTHER, SECRET, 42]) assert.equal(decide(r, presented, OFF), before);
  }
  assert.equal(bootstrapDecision(row(), NOW), "bound");
});

test("the secret is checked before the throttle, and a wrong one never becomes anything but unbound", () => {
  const recent = row({ secret_hash: HASH, last_bootstrap_at: at(-1000) });
  assert.equal(decide(recent, SECRET, OFF), "throttled", "the real tablet in a reload loop is still throttled");
  assert.equal(decide(recent, OTHER, OFF), "unbound");
  assert.equal(decide(recent, undefined, ON), "unbound");
  assert.equal(decide(row({ secret_hash: HASH, restaurant_id: null }), SECRET, ON), "unbound", "unassigned mints for nobody, secret or not");
  assert.equal(decide(row({ secret_hash: "" }), SECRET, OFF), "unbound", "an empty hash is a hash nothing matches, not 'no hash'");
  assert.equal(decide(null, SECRET, ON), "unbound");
});

test("unbound and throttled are the same body on the wire, so a stranger cannot tell a live serial from an unknown one", () => {
  assert.deepEqual(bootstrapWaitReply(), { status: "unbound", poll_every_ms: BOOTSTRAP_POLL_MS });
  const route = src("app/api/kiosk/bootstrap/route.ts");
  assert.doesNotMatch(route, /status: decision/, "the decision itself never reaches the caller");
  assert.doesNotMatch(route, /status: "throttled"/);
  // Two exits that mint nothing, one body: not bound, and bound to a restaurant that is gone.
  assert.equal(route.split("NextResponse.json(bootstrapWaitReply(), { headers: noStore })").length - 1, 2);
  // The page treats every non-bound answer the same way: it only ever looks for "bound".
  const page = src("app/link/page.tsx");
  assert.match(page, /data\?\.status === "bound" && typeof data\.token_hash === "string"/);
  assert.doesNotMatch(page, /"throttled"|status === "unbound"/);
});

// Safety 2.
test("the raw secret is never stored, logged or returned by the bridge", () => {
  const route = src("app/api/kiosk/bootstrap/route.ts");
  assert.equal(route.split("body?.secret").length - 1, 1, "read once, into the comparison, and nowhere else");
  assert.match(route, /from\("kiosk_bootstrap_log"\)\.insert\(\{ device_ref: device, ip, at: nowIso \}\)/, "the log row is reference, address, time");
  assert.doesNotMatch(route, /console\./);
  assert.doesNotMatch(route.slice(route.indexOf(".upsert("), route.indexOf("onConflict")), /secret/);
  // 42703 only: a read that failed for any other reason is "no row", never "a row with no secret".
  assert.match(route, /error\.code === "42703" && \/secret_hash\//);

  const status = src("app/api/kiosk/link-status/route.ts");
  assert.match(status, /secret_hash: hashDeviceSecret\(secret\)/, "the link flow stores the hash");
  assert.doesNotMatch(status, /console\./);

  const crm = src("app/api/crm/devices/[id]/secret/route.ts");
  assert.equal(crm.split("authorizeCrmWrite(req)").length - 1, 2, "POST and GET both need the CRM key");
  assert.match(crm, /"secret" in body/, "a body carrying the secret itself is refused");
  assert.match(crm, /isSecretHash\(hash\)/);
  assert.match(crm, /has_secret: row\?\.secret_hash != null/, "GET says yes or no");
  assert.doesNotMatch(crm, /secret_hash: row|secret_hash: before|secret_hash: data/, "and never the hash");
  assert.doesNotMatch(crm, /console\.log\([^)]*hash\b(?! === null)/);
  // No other read path selects the column.
  for (const p of ["app/api/crm/tablets/unbound/route.ts", "lib/crm-roster.ts", "app/api/dashboard/heartbeat/route.ts"]) {
    assert.doesNotMatch(src(p), /secret_hash/, p);
  }
});

test("migration 067 adds one nullable column, and can run twice", () => {
  const sql = src("db/migrations/067_kiosk_device_secret.sql");
  assert.match(sql, /add column if not exists secret_hash text;/);
  assert.doesNotMatch(sql, /secret_hash text not null|default/i, "nullable, no default: existing rows stay 'no secret'");
  assert.match(sql, /if not exists \(select 1 from pg_constraint where conname = 'kiosk_devices_secret_hash_shape'\)/);
  assert.match(sql, /secret_hash is null or secret_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.doesNotMatch(sql, /update kiosk_devices|delete from/i, "it touches no existing row");
});

console.log("\nwhere a secret comes from:");

const AID = "aid:9774d56d682e549c";

test("link code: only an aid: tablet already bound to the restaurant the code was linked to is issued one", () => {
  assert.equal(mayIssueSecretOnLink(AID, { restaurant_id: "r1" }, "r1"), true);
  assert.equal(mayIssueSecretOnLink(AID, { restaurant_id: "r2" }, "r1"), false, "naming another restaurant's tablet gets nothing");
  assert.equal(mayIssueSecretOnLink(AID, { restaurant_id: null }, "r1"), false, "unbound: a secret would only wait for whoever is assigned next");
  assert.equal(mayIssueSecretOnLink(AID, null, "r1"), false, "never seen");
  assert.equal(mayIssueSecretOnLink("R52X30ABCDE", { restaurant_id: "r1" }, "r1"), false, "a Hexnode serial gets its secret from the CRM");
  assert.equal(mayIssueSecretOnLink("bad ref", { restaurant_id: "r1" }, "r1"), false);
  assert.equal(mayIssueSecretOnLink(null, { restaurant_id: "r1" }, "r1"), false, "the tablet did not ask");
  assert.equal(mayIssueSecretOnLink(AID, { restaurant_id: "r1" }, null), false);

  const status = src("app/api/kiosk/link-status/route.ts");
  assert.match(status, /mayIssueSecretOnLink\(ref, row as/);
  // Issued only after the code was claimed by its own device, written only onto a row still bound there,
  // and handed over only if that write landed.
  assert.ok(status.indexOf("issueDeviceSecret(admin, ref, claimed.restaurant_id, now)") > status.indexOf('.is("consumed_at", null)'));
  assert.match(status, /\.eq\("device_ref", ref\)\s*\.eq\("restaurant_id", restaurantId\)/);
  assert.match(status, /return !error && written \? secret : null;/);
  assert.match(status, /\.\.\.\(deviceSecret \? \{ device_secret: deviceSecret \} : \{\}\)/);
});

// Safety 4.
test("a move or unassign ends an aid: tablet's secret; a Hexnode serial keeps its own; the same restaurant changes nothing", () => {
  const held = [
    { device_ref: AID, restaurant_id: "r1" },
    { device_ref: "R52X30ABCDE", restaurant_id: "r1" },
  ];
  assert.deepEqual(secretsEndedByBind(held, [{ device_ref: AID, restaurant_id: "r1" }]), [], "the MDM sync re-sends the whole map");
  assert.deepEqual(secretsEndedByBind(held, [{ device_ref: AID, restaurant_id: "r2" }]), [AID], "moved");
  assert.deepEqual(secretsEndedByBind(held, [{ device_ref: AID, restaurant_id: null }]), [AID], "unassigned");
  assert.deepEqual(secretsEndedByBind(held, [{ device_ref: "R52X30ABCDE", restaurant_id: "r2" }]), [], "the MDM's secret is the unit's, not the restaurant's");
  assert.deepEqual(secretsEndedByBind(held, [{ device_ref: "R52X30ABCDE", restaurant_id: null }]), []);
  assert.deepEqual(secretsEndedByBind(held, [{ device_ref: "aid:0000000000000000", restaurant_id: "r2" }]), [], "holds no secret: nothing to end");
  assert.deepEqual(secretsEndedByBind([], [{ device_ref: AID, restaurant_id: "r2" }]), []);
  assert.deepEqual(
    secretsEndedByBind(held, [{ device_ref: AID, restaurant_id: "r2" }, { device_ref: AID, restaurant_id: "r2" }]),
    [AID],
    "once each"
  );
  // And either way, an unassigned tablet mints nothing, whatever it still holds.
  assert.equal(decide(row({ restaurant_id: null, secret_hash: HASH }), SECRET, OFF), "unbound");
  assert.equal(decide(row({ restaurant_id: null, secret_hash: HASH }), SECRET, ON), "unbound");
  // An aid: tablet whose secret was cleared by a move: as before with the switch off, link code with it on.
  assert.equal(decide(row({ device_ref: AID, restaurant_id: "r2", secret_hash: null }), SECRET, OFF), "bound");
  assert.equal(decide(row({ device_ref: AID, restaurant_id: "r2", secret_hash: null }), SECRET, ON), "unbound");

  const bind = src("app/api/crm/tablets/bind/route.ts");
  assert.match(bind, /secretsEndedByBind\(held\.rows, rows\)/);
  assert.ok(bind.indexOf("update({ secret_hash: null") < bind.indexOf('upsert(rows, { onConflict: "device_ref" })'), "cleared before the binding lands");
  assert.doesNotMatch(bind.slice(bind.indexOf("rows.push({"), bind.indexOf("let secretsCleared")), /secret_hash/, "the upsert itself never carries the column");
});

test("the CRM route takes a tablet reference, stores only a hash, and can clear it", () => {
  const crm = src("app/api/crm/devices/[id]/secret/route.ts");
  assert.match(crm, /isDeviceRef\(ref\) \|\| UUID\.test\(ref\)/, "a printer uuid is refused, not turned into a tablet row");
  assert.match(crm, /upsert\(\{ device_ref: ref, secret_hash: hash, updated_at: nowIso \}, \{ onConflict: "device_ref" \}\)/, "restaurant and the rest are left alone");
  assert.match(crm, /update\(\{ secret_hash: null, updated_at: nowIso \}\)/);
  const contract = src("docs/crm-bridge-contract.md");
  assert.match(contract, /\/api\/crm\/devices\/:ref\/secret/);
  assert.match(contract, /KIOSK_REQUIRE_SECRET/);
});

console.log("\non the tablet:");

// Safety 3: a lost or wrong secret is the existing "unbound -> link code" screen.
test("the page sends its secret in the bootstrap body, never in a URL, and a refusal is just the link-code screen", () => {
  const page = src("app/link/page.tsx");
  assert.match(page, /body: JSON\.stringify\(\{ device: deviceRef, secret: readDeviceSecret\(\) \?\? undefined, model/);
  assert.doesNotMatch(page, /[?&]secret=|encodeURIComponent\(readDeviceSecret|dsec=/, "no secret in any request URL");
  // No secret, a wrong one, unassigned, too soon: one answer, and the page does nothing with it but ask again.
  assert.doesNotMatch(page, /location\.reload/);
  assert.match(page, /setInterval\(ask, BOOTSTRAP_POLL_MS\)/);
  // The code screen does not depend on bootstrap at all: it is requested on mount, whatever bootstrap says.
  assert.match(page, /useEffect\(\(\) => \{\s*void requestCode\(\);\s*\}, \[requestCode\]\);/);
  // An aid: tablet asks for a secret with its link, only if it can keep one, and stores it before leaving.
  assert.match(page, /deviceRefKind\(deviceRef\) === "android_id" && canKeepDeviceSecret\(\)/);
  assert.match(page, /\(wantsSecret \? "&ref=" \+ encodeURIComponent\(deviceRef\) : ""\)/);
  const store = page.indexOf("writeDeviceSecret(data.device_secret)");
  assert.ok(store > 0 && store < page.indexOf("await settle(data.token_hash, data.restaurant ?? null);", store));
});

test("the shell hands the secret over in the URL fragment, which no server sees, and the page takes it off the address", () => {
  assert.equal(DEVICE_SECRET_FRAGMENT, "dsec");
  assert.equal(DEVICE_SECRET_KEY, "premium.deviceSecret");
  const start = "https://pfd-order-monitor.vercel.app/dashboard?shell=6&device=R52X30ABCDE";
  assert.equal(readSecretFragment(start + "#dsec=" + SECRET), SECRET);
  // The middleware's redirect to /link keeps the query, and the browser carries the fragment across it.
  assert.equal(readSecretFragment("https://pfd-order-monitor.vercel.app/link?shell=6&device=R52X30ABCDE&next=%2Fdashboard#dsec=" + SECRET), SECRET);
  assert.equal(readSecretFragment(start), null);
  assert.equal(readSecretFragment(start + "#dsec=short"), null);
  assert.equal(readSecretFragment(start + "?dsec=" + SECRET), null, "a query parameter is not where it travels");
  assert.equal(new URL(start + "#dsec=" + SECRET).search.includes(SECRET), false);
  assert.equal(readDeviceRef(start + "#dsec=" + SECRET), "R52X30ABCDE", "the reference still reads");

  const cache = src("lib/kiosk-cache.ts");
  assert.match(cache, /export function rememberDeviceRef\(url: string\): string \| null \{\s*rememberDeviceSecretFromUrl\(url\);/, "every page that learns the reference learns both");
  assert.match(cache, /history\.replaceState\(window\.history\.state, "", window\.location\.pathname \+ window\.location\.search\)/);

  const launcher = src("android/app/src/main/java/com/pfdworks/orders/LauncherActivity.java");
  assert.match(launcher, /DEVICE_SECRET_KEY = "device_secret"/);
  assert.match(launcher, /DEVICE_SECRET_FRAGMENT = "dsec"/);
  assert.match(launcher, /encodedFragment\(DEVICE_SECRET_FRAGMENT \+ "=" \+ secret\)/);
  assert.doesNotMatch(launcher, /appendQueryParameter\([^)]*(secret|SECRET)/, "never the query string: that is in every request log");
  assert.doesNotMatch(launcher, /Log\.[a-z]\(/, "the shell logs nothing");
  assert.match(launcher, /DEVICE_SECRET_PATTERN = "\[A-Za-z0-9_-\]\{32,128\}"/, "the same shape the bridge accepts");
  assert.match(src("android/app/src/main/res/xml/app_restrictions.xml"), /android:key="device_secret"/);
  const hexnode = JSON.parse(src("docs/hexnode-app-config.json"));
  assert.deepEqual(hexnode.managedProperty.map((p: { key: string }) => p.key), ["device_ref", "device_secret"]);
  const placeholder = hexnode.managedProperty[1].valueString;
  assert.equal(isDeviceSecret(placeholder) && /^[A-Za-z0-9_-]{43}$/.test(placeholder) && !/PASTE/.test(placeholder), false, "the checked-in payload holds a placeholder, not a secret");
});

console.log(`\n${passed} assertions passed.`);
