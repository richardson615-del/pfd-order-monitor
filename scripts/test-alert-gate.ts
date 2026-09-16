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
import { alertGateState, gateBlocks } from "../lib/alert-gate";

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
  //
  // It blocks only when the BROWSER holds no subscription - which is
  // genuinely silent. With one in hand, the server almost certainly has it
  // from a previous run, and today's refresh failing says nothing about
  // whether a push will actually arrive.
  assert.match(brain, /if \(hasSubscription\) \{/);
  const granted = brain.slice(
    brain.indexOf('if (permission === "granted")'),
    brain.indexOf("const next = alertGateState")
  );
  assert.ok(granted.length > 0, "the granted branch should be findable");
  assert.match(granted, /setState\("hidden"\)/, "a subscribed browser is let through");
  assert.match(granted, /setState\("ask"\)/, "an unsubscribed one is still blocked");
  // Either way the office is told this tablet is not confirmed.
  assert.match(granted, /onSubscribedChange\?\.\(false, "hidden"\)/);
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
  assert.match(brain, /export type OnAlertStateChange = \(subscribed: boolean, state: AlertGateState\) => void/);
  assert.match(brain, /onSubscribedChange\?\.\(false, next\)/);
  assert.doesNotMatch(brain, /onSubscribedChange\?\.\((true|false)\)/, "every report carries the state");
  assert.match(dashboard, /setAlertState\(state\)/);
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
  assert.match(dashboard, /JSON\.stringify\(\{ pushSubscribed, shellVersion, alertState \}\)/);
  assert.match(migration, /push_subscribed boolean/);
  // Nullable and undefaulted: existing rows genuinely do not know, and
  // defaulting them either way states something on no evidence.
  assert.doesNotMatch(migration, /not null|default (true|false)/i);
});

console.log(`\n${passed} assertions passed.`);
