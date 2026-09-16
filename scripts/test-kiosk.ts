/**
 * Rules for the dashboard running as an unattended kiosk.
 *
 * Every failure these guard against is silent in the same way: the screen
 * keeps showing "no new orders", which looks exactly like a quiet service.
 * Both directions are tested - it must warn when orders cannot arrive, and it
 * must not warn on a wifi hiccup, because a banner people learn to ignore is
 * worse than no banner.
 */
import assert from "node:assert/strict";
import {
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_STALE_AFTER_MS,
  POLL_DOWN_MS,
  POLL_LIVE_MS,
  STALE_AFTER_MS,
  isStale,
  kioskWarning,
  liveState,
  pollIntervalMs,
  realtimeConnection,
  unseen,
  HEARTBEAT_MIN_INTERVAL_MS,
  RELOAD_SPREAD_MS,
  pollDelayMs,
  reconnectDelayMs,
  reloadHoldMs,
  withJitter,
} from "@/lib/kiosk";

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

console.log("reading the realtime connection:");

test("SUBSCRIBED is the only status that counts as live", () =>
  assert.equal(realtimeConnection("SUBSCRIBED"), "live"));

test("every failure mode reads as down", () => {
  for (const s of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
    assert.equal(realtimeConnection(s), "down", `${s} must not read as healthy`);
  }
});

test("an unknown status is never treated as healthy", () =>
  // A future client version adding a status must fail towards a visible
  // warning, not towards a screen that quietly lies.
  assert.equal(realtimeConnection("SOMETHING_NEW"), "connecting"));

console.log("\npolling as the guarantee, not the optimisation:");

test("a healthy socket still polls", () =>
  assert.equal(pollIntervalMs("live"), POLL_LIVE_MS));

test("a dead socket polls faster, because the poll IS the alert then", () => {
  assert.equal(pollIntervalMs("down"), POLL_DOWN_MS);
  assert.ok(POLL_DOWN_MS < POLL_LIVE_MS);
});

console.log("\nstaleness:");

test("a screen that has never synced is not yet stale", () =>
  assert.equal(isStale(null, Date.now()), false));

test("a recent sync is not stale", () =>
  assert.equal(isStale(1_000_000, 1_000_000 + POLL_LIVE_MS), false));

test("one missed poll is not an outage", () =>
  assert.equal(
    isStale(1_000_000, 1_000_000 + STALE_AFTER_MS - 1),
    false,
    "a single wifi blip must not flash a banner"
  ));

test("several missed polls is", () =>
  assert.equal(isStale(1_000_000, 1_000_000 + STALE_AFTER_MS), true));

console.log("\nwhat the strip says:");

const ok = { connection: "live" as const, soundArmed: true, stale: false };

test("a healthy kiosk shows nothing at all", () =>
  assert.equal(kioskWarning(ok), null));

test("silent sound outranks everything", () => {
  // The dangerous case: connected, listed, up to date, and unable to make a
  // noise. It looks completely healthy, and the entire point of the tablet is
  // that someone notices an order without watching the screen.
  const w = kioskWarning({ ...ok, soundArmed: false, connection: "down" });
  assert.equal(w?.level, "critical");
  assert.match(w!.text, /touch the screen/i, "it must say what fixes it");
});

test("a dead socket is critical and names the likely cause", () => {
  const w = kioskWarning({ ...ok, connection: "down" });
  assert.equal(w?.level, "critical");
  assert.match(w!.text, /wifi/i);
});

test("a stale screen warns even while the socket claims to be live", () => {
  // The exact three-week-old-tab case: the client believes it is subscribed
  // and nothing has actually arrived.
  const w = kioskWarning({ ...ok, stale: true });
  assert.equal(w?.level, "critical");
});

test("connecting is a warning, not a page-stopping alarm", () => {
  const w = kioskWarning({ ...ok, connection: "connecting" });
  assert.equal(w?.level, "warning");
});

console.log("\nwhat the chime sounds for:");

/**
 * A fixed clock, passed to EVERY unseen() call.
 *
 * Three assertions here were left on the default Date.now() when the
 * six-hour chime window landed. They passed when written and failed hours
 * later the same evening, because the fixtures are dated relative to NOW and
 * the real clock had walked past the window. A test whose result depends on
 * the time of day is broken whichever way it happens to land.
 */
const NOW = Date.parse("2026-09-11T19:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const order = (over: Record<string, any> = {}) => ({
  id: "o1",
  status: "new",
  opened_at: null as string | null,
  accepted_at: null as string | null,
  received_at: minutesAgo(2),
  ...over,
});

test("an order nobody has opened keeps the alert going", () =>
  assert.equal(unseen([order()], NOW).length, 1));

test("opening the ticket silences it - opening is the acknowledgement", () => {
  // There is no Accept step (Nick, 2026-09-16). The order page stamps
  // opened_at on first view, and that is what stops the chime.
  assert.equal(unseen([order({ status: "opened", opened_at: minutesAgo(1) })], NOW).length, 0);
});

test("status 'opened' alone is not enough - the stamp is", () => {
  // The status word and the timestamp used to be able to disagree (a
  // 'printed' order that was opened kept its status). The chime reads the
  // stamp, which is written whatever the status.
  assert.equal(unseen([order({ status: "opened" })], NOW).length, 1);
  assert.equal(unseen([order({ status: "printed", opened_at: minutesAgo(1) })], NOW).length, 0);
});

test("an order accepted under the old button does not start ringing again", () =>
  assert.equal(unseen([order({ accepted_at: "2026-09-10T18:00:00Z" })], NOW).length, 0));

test("the paper channel does not answer for the tablet", () => {
  // The printer and the tablet are independent ways for a restaurant to
  // receive an order. A ticket having printed says nothing about whether the
  // tablet has done its job, so it cannot silence it.
  assert.equal(unseen([order({ status: "printed" })], NOW).length, 1);
});

test("a cancelled order never chimes, opened or not", () =>
  // The point of a cancellation is that the food is NOT to be made. Sounding
  // an alert to demand acknowledgement of that would be worse than useless.
  assert.equal(unseen([order({ status: "cancelled" })], NOW).length, 0));

test("a completed order never chimes", () =>
  assert.equal(unseen([order({ status: "completed" })], NOW).length, 0));

test("it counts every unopened order, not just the first", () =>
  assert.equal(
    unseen(
      [order({ id: "a" }), order({ id: "b", status: "printed" }), order({ id: "c", opened_at: "x" })],
      NOW
    ).length,
    2
  ));

console.log("\nthe backlog a new tablet inherits:");

test("an order older than a service does not chime", () => {
  // The first real install: a restaurant that had been taking orders for
  // months signed a tablet in, and every order they had ever taken was
  // unopened - because until that moment there was no tablet to open one
  // on. The screen came up chiming about the entire backlog, and the only way
  // to silence it was to open each order in turn.
  assert.equal(unseen([order({ received_at: minutesAgo(7 * 60) })], NOW).length, 0);
});

test("an order from earlier in the same service still chimes", () => {
  // The window has to be wider than a service, or it would silence a real
  // order during a genuinely busy night - which is the failure that actually
  // costs a restaurant money.
  assert.equal(unseen([order({ received_at: minutesAgo(5 * 60) })], NOW).length, 1);
});

test("a missing timestamp chimes rather than going quiet", () => {
  // A field we cannot read must never be the reason an order goes
  // unannounced. Silence is the expensive failure here, noise is not.
  assert.equal(unseen([order({ received_at: null })], NOW).length, 1);
  assert.equal(unseen([order({ received_at: "not a date" })], NOW).length, 1);
});

test("age alone never overrides opening or cancellation", () => {
  // The age check narrows what chimes; it must not widen it.
  assert.equal(unseen([order({ received_at: minutesAgo(1), status: "cancelled" })], NOW).length, 0);
  assert.equal(unseen([order({ received_at: minutesAgo(1), opened_at: "x" })], NOW).length, 0);
});

console.log("\nthe dashboard actually applies them:");

import { readFileSync } from "node:fs";
const dash = readFileSync(
  new URL("../components/OrderDashboard.tsx", import.meta.url),
  "utf8"
);
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the realtime subscription observes its own status", () =>
  assert.match(
    dash,
    /\.subscribe\(\(status\)/,
    "subscribe() with no callback is how a dropped channel became invisible"
  ));

test("polling does not depend on the socket being down", () =>
  // A jittered timeout chain since E3, still unconditional on the socket:
  // the delay is a function of connection state, never gated on it.
  assert.match(dash, /\}, pollDelayMs\(connection\)\);/));

test("reconnecting resyncs, because the tab missed whatever arrived", () =>
  assert.match(dash, /if \(next === "live"\) void sync\(\)/));

test("the chime never fires while sound is known to be off", () =>
  assert.match(
    dash,
    /hasNewOrders && soundArmed/,
    "beeping into a suspended context is what made the failure silent"
  ));

test("the dashboard says it is open, and again on returning to the foreground", () => {
  // A push subscription outlives being signed out, so this is the only signal
  // that tells a watched screen from a dead one.
  assert.match(dash, /\/api\/dashboard\/heartbeat/);
  assert.match(dash, /setInterval\(beat, HEARTBEAT_EVERY_MS\)/);
  assert.match(dash, /visibilitychange/);
});

test("a failed heartbeat cannot disturb the thing it reports on", () => {
  // A tablet that cannot record a heartbeat is still showing orders.
  //
  // Scoped to the beat function rather than "within 200 characters of the
  // word heartbeat": the body grew when the beat started reporting whether
  // this screen can ring, and a proximity window measures formatting, not
  // whether the failure is swallowed.
  const beat = dash.slice(dash.indexOf("const beat = () =>"), dash.indexOf("beat();"));
  assert.ok(beat.length > 0, "the beat function should be findable");
  // The catch may carry a comment now (the beat also answers the version
  // check), but it must still do nothing: no state, no reload, no rethrow.
  const caught = beat.slice(beat.indexOf(".catch(() => {"));
  assert.ok(caught.length > 0, "the failure must be caught");
  assert.doesNotMatch(caught.slice(0, caught.indexOf("});") + 3), /set[A-Z]\w+\(|reload|throw/);
});

test("the chime is keyed on opening, not on status", () => {
  assert.match(dash, /unseen\(orders\)/);
  assert.doesNotMatch(
    dash,
    /o\.status === "new"/,
    "the status word can disagree with the stamp; the stamp is what is read"
  );
  // And the order page writes the stamp - both stamps - on first view,
  // never twice, and never on a settled order.
  const page = src("app/order/[id]/page.tsx");
  assert.match(page, /if \(!order\.opened_at\) update\.opened_at = now;/);
  assert.match(page, /if \(!order\.accepted_at\) update\.accepted_at = now;/);
  assert.match(page, /!SETTLED\.has\(order\.status\)/);
});

console.log("\nwhat the status pill is allowed to claim:");

const base = {
  connection: "live" as const,
  stale: false,
  soundArmed: true,
  pushSubscribed: true,
  heartbeatOkAt: 1_000_000,
  now: 1_000_000,
};

test("everything working reads Live, with nothing to say", () => {
  const s = liveState(base);
  assert.equal(s.level, "live");
  assert.equal(s.detail, null);
});

test("a dead channel is offline, whatever else is fine", () => {
  assert.equal(liveState({ ...base, connection: "down" }).level, "offline");
  assert.equal(liveState({ ...base, stale: true }).level, "offline");
});

test("silent sound outranks every other degradation", () => {
  // A connected tablet that cannot chime looks perfectly healthy, and the
  // whole point of the tablet is somebody noticing without watching it.
  const s = liveState({ ...base, soundArmed: false, pushSubscribed: false, heartbeatOkAt: 0 });
  assert.equal(s.level, "degraded");
  assert.match(s.detail ?? "", /Sound is off/);
});

test("no push subscription is named, not hidden behind a green pill", () => {
  const s = liveState({ ...base, pushSubscribed: false });
  assert.equal(s.level, "degraded");
  assert.match(s.detail ?? "", /Alerts are off/);
});

test("a stale heartbeat says the office cannot see it, and that orders still arrive", () => {
  const s = liveState({ ...base, heartbeatOkAt: 0, now: HEARTBEAT_STALE_AFTER_MS + 1 });
  assert.equal(s.level, "degraded");
  assert.match(s.detail ?? "", /office cannot see/);
});

test("one missed heartbeat is not an outage", () => {
  const s = liveState({ ...base, heartbeatOkAt: 0, now: HEARTBEAT_EVERY_MS + 1 });
  assert.equal(s.level, "live");
});

test("not-yet-known is not the same as missing", () => {
  // On first paint nothing has reported in. A screen that flashes amber for a
  // second on every load is one nobody reads.
  const s = liveState({ ...base, pushSubscribed: null, heartbeatOkAt: null });
  assert.equal(s.level, "live");
});

test("connecting is degraded, never live and never offline", () => {
  const s = liveState({ ...base, connection: "connecting" });
  assert.equal(s.level, "degraded");
  assert.equal(s.label, "Connecting");
});

console.log(`\n${passed} assertions passed.`);

console.log("\nfive hundred tablets do not all move at once (E3):");

const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};

test("the poll is jittered ±20% around its cadence, never the same second on two tablets", () => {
  assert.equal(pollDelayMs("live", seq(0)), 48_000);
  assert.equal(pollDelayMs("live", seq(1)), 72_000);
  assert.equal(pollDelayMs("live", seq(0.5)), 60_000);
  assert.equal(pollDelayMs("connecting", seq(0.5)), 15_000);
  assert.equal(withJitter(1000, seq(-5)), 800, "rand below 0 is clamped");
  assert.equal(withJitter(1000, seq(7)), 1200, "rand above 1 is clamped");
});

test("reconnects back off exponentially with full jitter, capped at a minute", () => {
  assert.equal(reconnectDelayMs(0, seq(1)), 1_000);
  assert.equal(reconnectDelayMs(3, seq(1)), 8_000);
  assert.equal(reconnectDelayMs(10, seq(1)), 60_000, "capped");
  assert.equal(reconnectDelayMs(3, seq(0)), 0, "full jitter reaches zero");
  assert.equal(reconnectDelayMs(3, seq(0.5)), 4_000);
  assert.equal(reconnectDelayMs(-2, seq(1)), 1_000, "a negative attempt is the first");
});

test("a new build is taken somewhere in a ten-minute window, not on the next beat for everyone", () => {
  assert.equal(reloadHoldMs(seq(0)), 0);
  assert.equal(reloadHoldMs(seq(1)), 600_000);
  assert.equal(RELOAD_SPREAD_MS, 10 * 60_000);
});

test("the client uses the jittered rules, and reconnects through them", () => {
  assert.match(dash, /setTimeout\(\(\) => \{[\s\S]*?void sync\(\);[\s\S]*?\}, pollDelayMs\(connection\)\)/, "poll is a jittered timeout chain");
  assert.doesNotMatch(dash, /setInterval\(\(\) => void sync\(\)/, "no fixed-interval poll");
  assert.match(dash, /reloadNotBeforeRef\.current = Date\.now\(\) \+ reloadHoldMs\(\)/);
  assert.match(dash, /Date\.now\(\) < reloadNotBeforeRef\.current\) return;/);
  const client = src("lib/supabase-browser.ts");
  assert.match(client, /reconnectAfterMs: \(tries: number\) => reconnectDelayMs\(tries\)/);
});

test("a heartbeat faster than once a minute is refused, and the client reads that as alive", () => {
  const route = src("app/api/dashboard/heartbeat/route.ts");
  assert.match(route, /HEARTBEAT_MIN_INTERVAL_MS/);
  assert.match(route, /status: 429/);
  assert.equal(HEARTBEAT_MIN_INTERVAL_MS, 60_000);
  assert.ok(HEARTBEAT_MIN_INTERVAL_MS < HEARTBEAT_EVERY_MS, "the limit must be under the cadence or every beat is refused");
  assert.match(dash, /res\.ok \|\| res\.status === 429\) setHeartbeatOkAt/);
});

test("push fan-out is bounded: twenty in flight, fifty per restaurant, newest first, and never in the ingest path", () => {
  const push = src("lib/push.ts");
  assert.match(push, /PUSH_CONCURRENCY = 20/);
  assert.match(push, /MAX_SUBSCRIPTIONS_PER_RESTAURANT = 50/);
  assert.match(push, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(push, /mapWithConcurrency\(targets, PUSH_CONCURRENCY/);
  // Ingest wraps each destination in attempt(), which swallows and logs:
  // the push cannot fail the print, or the insert.
  const canonical = src("lib/canonical.ts");
  assert.match(canonical, /await attempt\("app alert", inserted\.id/);
});

test("the two crons say how long they took", () => {
  assert.match(src("app/api/gmail/poll/route.ts"), /gmail poll SLOW/);
  assert.match(src("lib/health.ts"), /health snapshot collected in/);
});
