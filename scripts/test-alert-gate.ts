/**
 * Assertions for making order alerts non-optional.
 *
 * The thing being protected is a negative: there must be no path to the order
 * list on a tablet that cannot ring. Every previous version of this had one -
 * the "Enable notifications" button sat in the corner, nothing prompted, and
 * a tablet could run for a month with alerts off behind a green screen.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALERT_REASONS,
  GATE_CONFIRM_MS,
  alertGateState,
  browserHostHint,
  gateBlocks,
  readGate,
  settleGate,
  type GateMemory,
  type GateVerdict,
} from "../lib/alert-gate";

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
const gate = src("components/AlertGate.tsx");
// The gate's brain moved into a hook on 2026-09-16 so the first-run Ready
// screen can share it (Workstream I). The reading, the silent repair and the
// one tap are asserted against the hook; the faces against the components.
const brain = src("components/useAlertGate.ts");
const ready = src("components/ReadyScreen.tsx");
const dashboard = src("components/OrderDashboard.tsx");
const sw = src("public/sw.js");
const migration = src("db/migrations/030_heartbeat_push_state.sql");

console.log("what the gate decides:");

test("granted and subscribed is the only way through", () => {
  assert.equal(
    alertGateState({ permission: "granted", hasSubscription: true, supported: true }),
    "hidden"
  );
  assert.equal(gateBlocks("hidden"), false);
});

test("granted but NOT subscribed still blocks", () => {
  // Permission alone sends nothing. A cleared cache, a reinstall or an
  // expired endpoint all land here, and all of them are silent.
  assert.equal(
    alertGateState({ permission: "granted", hasSubscription: false, supported: true }),
    "ask"
  );
});

test("never asked shows the one-tap gate", () => {
  assert.equal(
    alertGateState({ permission: "default", hasSubscription: false, supported: true }),
    "ask"
  );
});

test("denied outranks everything, because re-prompting is impossible", () => {
  // Once Android has been told Block, no code can ask again. The only honest
  // screen is the one that says how to undo it.
  assert.equal(
    alertGateState({ permission: "denied", hasSubscription: true, supported: true }),
    "blocked"
  );
});

test("no Push API at all is its own case, not 'ask'", () => {
  assert.equal(
    alertGateState({ permission: "granted", hasSubscription: true, supported: false }),
    "unsupported"
  );
  assert.equal(
    alertGateState({ permission: null, hasSubscription: null, supported: true }),
    "unsupported"
  );
});

test("not-yet-read does not flash a gate over a working screen", () => {
  // hasSubscription null means the async read is still in flight. Blocking on
  // it would put a full-screen overlay over a healthy order list for half a
  // second on every load, which teaches people to tap through it.
  assert.equal(
    alertGateState({ permission: "granted", hasSubscription: null, supported: true }),
    "hidden"
  );
});

test("every state except hidden blocks - there is no 'warn and continue'", () => {
  for (const state of ["ask", "blocked", "unsupported"] as const) {
    assert.equal(gateBlocks(state), true, state);
  }
});

console.log("\nthere is no way round it:");

test("the old opt-in button is gone, not merely hidden", () => {
  assert.doesNotMatch(dashboard, /PushSetup/);
  assert.match(dashboard, /<AlertGate/);
});

test("the gate has no dismiss, no 'later', no close", () => {
  assert.doesNotMatch(gate, /later|not now|skip|dismiss/i);
  // aria-modal, so a screen reader cannot wander behind it either.
  assert.match(gate, /aria-modal="true"/);
});

test("the gate renders above the orders, not beside them", () => {
  const gateAt = dashboard.indexOf("<AlertGate");
  const listAt = dashboard.indexOf('className={`app-list');
  assert.ok(gateAt > -1 && listAt > -1);
  assert.ok(gateAt < listAt);
});

test("one tap does permission, subscription AND audio", () => {
  // All three need the same user gesture. Asking for it three times is how
  // two of them never happen.
  const turnOn = brain.slice(brain.indexOf("const turnOn = useCallback"), brain.indexOf("return { state, busy, error"));
  assert.match(turnOn, /requestPermission\(\)/);
  assert.match(turnOn, /subscribeAndRecord\(\)/);
  // A tap is answered at once - the debounce is for reads nobody asked for.
  assert.match(turnOn, /land\([\s\S]*, false\)/);
  assert.match(turnOn, /armAudio\(\)/);
});

test("the gate and the Ready screen share one brain", () => {
  // Two faces, one answer to "will this tablet ring?". A second copy of the
  // subscribe path in the Ready screen is how the two would drift.
  assert.match(gate, /useAlertGate\(onSubscribedChange\)/);
  assert.match(ready, /useAlertGate\(onSubscribedChange\)/);
  assert.doesNotMatch(ready, /pushManager|requestPermission/);
  assert.doesNotMatch(gate, /pushManager|requestPermission/);
});

test("the Ready screen does not move on while alerts are off", () => {
  // That would be the old dismissible button under a new name. The printer
  // row is advisory (orders still show without paper); Wi-Fi and alerts are
  // not.
  assert.match(ready, /disabled=\{!ready\}/);
  assert.match(src("lib/first-run.ts"), /filter\(\(c\) => c\.key !== "printer"\)\.every\(\(c\) => c\.ok === true\)/);
  // First run shows the Ready screen INSTEAD of the gate, never neither.
  assert.match(dashboard, /firstRun === true \? \([\s\S]*<ReadyScreen[\s\S]*\) : firstRun === false \? \([\s\S]*<AlertGate/);
});

test("a failed re-record does not lock a working tablet out of its orders", () => {
  // Reported from a live tablet: push_subscriptions has no UPDATE policy, so
  // re-recording an existing endpoint was refused by RLS on every load, and
  // this gate put itself up over a screen that was receiving orders fine.
  // With a subscription in hand, the server almost certainly has it from a
  // previous run; today's record failing says nothing about whether a push
  // will arrive. Hidden, but not counted as subscribed, and the reason says so.
  assert.deepEqual(
    readGate({ supported: true, permission: "granted", subscription: "present", recorded: false }),
    { state: "hidden", reason: "record_failed", subscribed: false }
  );
  assert.deepEqual(
    readGate({ supported: true, permission: "granted", subscription: "present", recorded: true }),
    { state: "hidden", reason: null, subscribed: true }
  );
  // The hook reads through readGate rather than deciding inline.
  assert.match(brain, /land\(readGate\(\{ supported: true, permission, subscription, recorded \}\), true\)/);
});

test("the subscription write is not refused by its own RLS", () => {
  // push_subscriptions has insert/select/delete policies and NO update
  // policy, and an upsert onto an existing endpoint IS an update. Authorised
  // by the session, written with the service role - an update policy alone
  // would not do, because re-binding a tablet to a different restaurant hits
  // a row owned by the previous user, which auth_user_id = auth.uid()
  // refuses by design.
  const subscribeRoute = src("app/api/push/subscribe/route.ts");
  assert.match(subscribeRoute, /supabaseAdmin\(\)\.from\("push_subscriptions"\)\.upsert/);
  // Ownership still comes from the session, never from the body.
  assert.match(subscribeRoute, /auth_user_id: user\.id/);
  assert.match(subscribeRoute, /restaurant_id: restaurantIds\[0\]/);
});

test("the real error is shown, not swallowed into a console", () => {
  // Nobody standing at a wall-mounted tablet can open a console.
  assert.match(gate, /alert-gate-error/);
  assert.match(ready, /alert-gate-error/);
  assert.match(brain, /err instanceof Error \? err\.message/);
});

console.log("\non a kiosk, blocked is the office's problem:");

test("the blocked screen never sends anyone to Android Settings", () => {
  // Nick, 2026-09-16: the Hexnode policy pre-grants the notification
  // permission (App Permissions -> Premium -> Send push notifications:
  // Allow). A kiosk has no Settings app to open, so a screen that says
  // "open Settings -> Apps -> Premium" is a screen that cannot be obeyed.
  // "blocked" means the policy is missing, and only the office can fix it.
  for (const [name, face] of [["gate", gate], ["ready", ready]] as const) {
    assert.doesNotMatch(face, /Open Android|Android <strong>Settings|Settings<\/strong> →|Apps<\/strong>/, name);
    assert.match(face, /Alerts are off on this tablet/, name);
    assert.match(face, /SUPPORT_PHONE/, name);
  }
  assert.match(src("lib/first-run.ts"), /SUPPORT_PHONE = "\(615\) 619-5081"/);
});

test("the office is told which gate state the screen is in", () => {
  // The hook reports the state with the boolean, the dashboard puts it on
  // the heartbeat, and the CRM roster relays it: `blocked` on a kiosk is a
  // Hexnode console job, not a phone call to the store.
  assert.match(
    brain,
    /export type OnAlertStateChange = \(subscribed: boolean, state: AlertGateState, reason: AlertReason \| null\) => void/
  );
  assert.match(brain, /onSubscribedChange\?\.\(verdict\.subscribed, next\.shown, verdict\.reason\)/);
  assert.doesNotMatch(brain, /onSubscribedChange\?\.\((true|false)\)/, "every report carries the state");
  assert.match(dashboard, /setAlertState\(state\)/);
  assert.match(dashboard, /setAlertReason\(reason\)/);
  assert.match(src("lib/tablet-status.ts"), /alert_state: ALERT_STATES\.has/);
  assert.match(src("lib/crm-roster.ts"), /push_subscribed, shell_version, alert_state/);
  assert.match(src("docs/crm-bridge-contract.md"), /"alert_state"/);
});

test("a blocked screen re-reads the permission on its own, because nobody will tap", () => {
  // The fix lands from the Hexnode console with nobody at the tablet, and a
  // kiosk is always visible so visibilitychange never fires. Once a minute
  // is often enough; the gate comes down by itself when the policy returns.
  assert.match(brain, /if \(state !== "blocked"\) return;[\s\S]*setInterval\(\(\) => void check\(\), BLOCKED_RECHECK_MS\)/);
  assert.match(brain, /BLOCKED_RECHECK_MS = 60_000/);
});

console.log("\nit stays on once it is on:");

test("the service worker re-subscribes when the browser retires an endpoint", () => {
  // Unhandled, this is the failure the whole workstream exists to remove: the
  // tablet stops ringing and nothing on screen changes.
  assert.match(sw, /pushsubscriptionchange/);
  assert.match(sw, /pushManager\.subscribe\(/);
});

test("the worker sends credentials, because the route reads a cookie", () => {
  assert.match(sw, /credentials: "include"/);
});

test("the page re-records the subscription on every return to the foreground", () => {
  // This is what repairs whatever the worker could not: a service worker
  // cannot refresh an expired Supabase session, the page can.
  assert.match(brain, /visibilitychange/);
  assert.match(brain, /subscribeAndRecord/);
});

test("the heartbeat reports whether this screen can ring, and why not", () => {
  assert.match(dashboard, /JSON\.stringify\(\{\s*pushSubscribed,\s*shellVersion,\s*alertState,\s*alertReason,/);
  assert.match(migration, /push_subscribed boolean/);
  // Nullable and undefaulted: existing rows genuinely do not know, and
  // defaulting them either way states something on no evidence.
  assert.doesNotMatch(migration, /not null|default (true|false)/i);
});

console.log("\nit does not come back on a working tablet (Workstream AG, 2026-10-03):");

const hiddenOk: GateVerdict = { state: "hidden", reason: null, subscribed: true };
const working: GateMemory = { shown: "hidden", failingSince: null };

test("(a) granted, the read throws and the record fails, previously hidden: stays hidden", () => {
  // Willie Mae's Tab A11: a network blip or a service worker still waking on
  // the first read after the screen came on put the full gate up.
  const v = readGate({ supported: true, permission: "granted", subscription: "unknown", recorded: false });
  assert.deepEqual(v, { state: "hidden", reason: "sub_read_failed", subscribed: false });
  const after = settleGate(working, v, 1_000);
  assert.equal(after.shown, "hidden");
});

test("(b) granted, known no subscription, subscribe fails twice 30 s apart: ask", () => {
  const v = readGate({ supported: true, permission: "granted", subscription: "absent", recorded: false });
  assert.deepEqual(v, { state: "ask", reason: "sub_absent", subscribed: false });
  const first = settleGate(working, v, 0);
  assert.equal(first.shown, "hidden", "the first failing read on a working screen never raises");
  assert.equal(first.recheckInMs, GATE_CONFIRM_MS, "and it asks again itself - a kiosk never fires visibilitychange");
  const tooSoon = settleGate(first, v, GATE_CONFIRM_MS - 1);
  assert.equal(tooSoon.shown, "hidden", "two reads under 30 s apart are one blip");
  assert.equal(tooSoon.recheckInMs, 1);
  const second = settleGate(tooSoon, v, GATE_CONFIRM_MS);
  assert.equal(second.shown, "ask");
});

test("(c) never allowed: ask", () => {
  const v = readGate({ supported: true, permission: "default", subscription: "unknown", recorded: false });
  assert.deepEqual(v, { state: "ask", reason: "perm_default", subscribed: false });
  assert.equal(settleGate({ shown: null, failingSince: null }, v, 0).shown, "ask", "first read on a fresh screen shows at once");
});

test("(d) denied: blocked", () => {
  const v = readGate({ supported: true, permission: "denied", subscription: "present", recorded: true });
  assert.deepEqual(v, { state: "blocked", reason: "perm_denied", subscribed: false });
  assert.equal(settleGate({ shown: null, failingSince: null }, v, 0).shown, "blocked");
});

test("no Push API is unsupported, with its own reason", () => {
  assert.deepEqual(readGate({ supported: false, permission: null, subscription: "unknown", recorded: false }), {
    state: "unsupported",
    reason: "unsupported",
    subscribed: false,
  });
});

test("a good read between two bad ones starts the count again", () => {
  const bad = readGate({ supported: true, permission: "default", subscription: "unknown", recorded: false });
  const a = settleGate(working, bad, 0);
  const b = settleGate(a, hiddenOk, 10_000);
  assert.deepEqual(b, { shown: "hidden", failingSince: null, recheckInMs: null });
  const c = settleGate(b, bad, 40_000);
  assert.equal(c.shown, "hidden", "not consecutive, so not two");
  assert.equal(settleGate(c, bad, 40_000 + GATE_CONFIRM_MS).shown, "ask");
});

test("a gate already up follows the read at once, both ways", () => {
  const up: GateMemory = { shown: "ask", failingSince: null };
  assert.equal(settleGate(up, hiddenOk, 0).shown, "hidden", "the gate comes down on the first good read");
  const denied = readGate({ supported: true, permission: "denied", subscription: "unknown", recorded: false });
  assert.equal(settleGate(up, denied, 0).shown, "blocked");
});

test("twenty wakes with transient failures never show the gate", () => {
  // The brief's done-means, as a simulation: every wake fails one way or
  // another that does not say alerts are off, a few seconds apart.
  let m: GateMemory & { recheckInMs: number | null } = { ...working, recheckInMs: null };
  const flaky = [
    readGate({ supported: true, permission: "granted", subscription: "unknown", recorded: false }),
    readGate({ supported: true, permission: "granted", subscription: "present", recorded: false }),
  ];
  for (let i = 0; i < 20; i++) {
    m = settleGate(m, flaky[i % 2], i * 5_000);
    assert.equal(m.shown, "hidden", `wake ${i}`);
  }
});

test("the hook re-reads after a held failure, and clears the timer", () => {
  assert.match(brain, /setTimeout\(\(\) => void checkRef\.current\(\), next\.recheckInMs\)/);
  assert.match(brain, /clearTimeout\(recheckTimer\.current\)/);
  // A worker that never starts must not hang the read forever.
  assert.match(brain, /SW_READY_TIMEOUT_MS/);
});

test("the subscription has three answers, and only 'absent' comes from a failed subscribe", () => {
  assert.match(brain, /return \{ subscription: "unknown"/);
  assert.match(brain, /return \{ subscription: "absent"/);
  // The read that used to fold "threw" into false is gone.
  assert.doesNotMatch(brain, /hasSubscription = null/);
});

test("reason codes match the heartbeat column's CHECK", () => {
  const m047 = src("db/migrations/047_heartbeat_alert_reason.sql");
  const codes = ALERT_REASONS.map((r) => `'${r}'`).join(", ");
  assert.ok(m047.includes(`check (alert_reason in (${codes}))`));
  assert.ok(m047.includes(`check (alert_raised_reason in (${codes}))`));
});

test("the dashboard records when the gate went up and why", () => {
  assert.match(dashboard, /state !== "hidden" && \(lastAlertState\.current === null \|\| lastAlertState\.current === "hidden"\)/);
  assert.match(dashboard, /alertRaisedAt: alertRaise\?\.at \?\? null/);
});

console.log("\nan unmanaged tablet is told which browser to fix (AG3):");

test("Samsung Internet and WebView get the Chrome line; Chrome gets nothing", () => {
  const samsung =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/130.0.0.0 Safari/537.36";
  const webview = "Mozilla/5.0 (Linux; Android 14; SM-X133 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Safari/537.36";
  const chrome = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  assert.match(browserHostHint(samsung)!, /Samsung Internet[\s\S]*Chrome/);
  assert.match(browserHostHint(webview)!, /Chrome/);
  assert.equal(browserHostHint(chrome), null);
  assert.equal(browserHostHint(null), null);
});

test("both faces show it while the gate is up", () => {
  assert.match(gate, /browserHostHint\(/);
  assert.match(gate, /alert-gate-host/);
  assert.match(ready, /browserHostHint\(/);
  assert.match(ready, /gate\.state !== null && gate\.state !== "hidden" && hostHint/);
});

console.log(`\n${passed} assertions passed.`);
