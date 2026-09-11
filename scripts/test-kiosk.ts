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
  POLL_DOWN_MS,
  POLL_LIVE_MS,
  STALE_AFTER_MS,
  isStale,
  kioskWarning,
  pollIntervalMs,
  realtimeConnection,
  unaccepted,
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

const order = (over: Record<string, any> = {}) => ({
  id: "o1",
  status: "new",
  accepted_at: null as string | null,
  ...over,
});

test("an order nobody has accepted keeps the alert going", () =>
  assert.equal(unaccepted([order()]).length, 1));

test("opening an order does NOT silence it", () => {
  // The whole reason acceptance exists. 'opened' is stamped by merely tapping
  // the order - a glance, or a mis-tap - and it used to stop the chime
  // without anyone having agreed to cook anything.
  assert.equal(unaccepted([order({ status: "opened" })]).length, 1);
});

test("accepting it does", () =>
  assert.equal(
    unaccepted([order({ status: "opened", accepted_at: "2026-09-10T18:00:00Z" })]).length,
    0
  ));

test("the paper channel does not answer for the tablet", () => {
  // The printer and the tablet are independent ways for a restaurant to
  // receive an order. A ticket having printed says nothing about whether the
  // tablet has done its job, so it cannot silence it.
  assert.equal(unaccepted([order({ status: "printed" })]).length, 1);
});

test("a cancelled order never chimes, accepted or not", () =>
  // The point of a cancellation is that the food is NOT to be made. Sounding
  // an alert to demand acknowledgement of that would be worse than useless.
  assert.equal(unaccepted([order({ status: "cancelled" })]).length, 0));

test("a completed order never chimes", () =>
  assert.equal(unaccepted([order({ status: "completed" })]).length, 0));

test("it counts every waiting order, not just the first", () =>
  assert.equal(
    unaccepted([order({ id: "a" }), order({ id: "b", status: "printed" }), order({ id: "c", accepted_at: "x" })])
      .length,
    2
  ));

console.log("\nthe dashboard actually applies them:");

import { readFileSync } from "node:fs";
const dash = readFileSync(
  new URL("../components/OrderDashboard.tsx", import.meta.url),
  "utf8"
);

test("the realtime subscription observes its own status", () =>
  assert.match(
    dash,
    /\.subscribe\(\(status\)/,
    "subscribe() with no callback is how a dropped channel became invisible"
  ));

test("polling does not depend on the socket being down", () =>
  assert.match(dash, /setInterval\(\(\) => void sync\(\), pollIntervalMs\(connection\)\)/));

test("reconnecting resyncs, because the tab missed whatever arrived", () =>
  assert.match(dash, /if \(next === "live"\) void sync\(\)/));

test("the chime never fires while sound is known to be off", () =>
  assert.match(
    dash,
    /hasNewOrders && soundArmed/,
    "beeping into a suspended context is what made the failure silent"
  ));

test("the chime is keyed on acceptance, not on status", () => {
  assert.match(dash, /unaccepted\(orders\)/);
  assert.doesNotMatch(
    dash,
    /o\.status === "new"/,
    "'new' clears itself on a tap - that is what acceptance replaced"
  );
});

console.log(`\n${passed} assertions passed.`);
