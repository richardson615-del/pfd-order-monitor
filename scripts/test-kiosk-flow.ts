/**
 * One tablet's first day, end to end, through the rules that decide it.
 *
 * The other suites each pin one file. This one walks the FLOW the brief
 * describes (docs/briefs/2026-09-16-kiosk-first-run-and-orders.md) in the
 * order a tablet on a wall at Willie Mae's would meet it: the shell hands
 * over a device reference, the bridge decides bound / unbound / throttled,
 * the office assigns it (or links it by code), the Ready screen passes,
 * orders arrive and chime, the lists sort themselves through the evening,
 * and the week's history lands on the right Chicago days. Every step is a
 * pure function; nothing here needs a browser, a database or a tablet.
 *
 * Acceptance for item 3 of docs/briefs/QUEUE.md.
 */
import assert from "node:assert/strict";
import {
  BOOTSTRAP_MINT_MIN_INTERVAL_MS,
  BOOTSTRAP_RATE_MAX,
  UNBOUND_VISIBLE_MS,
  bootstrapDecision,
  deviceRefKind,
  mayBootstrap,
  parseBindings,
  readDeviceRef,
} from "../lib/device-binding";
import {
  LINK_CODE_RATE_MAX,
  LINK_CODE_TTL_MS,
  generateLinkCode,
  isLinkCode,
  linkCodeState,
  mayCollect,
  mayCreateLinkCode,
  tokenHashFrom,
  type LinkCodeRow,
} from "../lib/link-code";
import { READY_AUTO_ADVANCE_MS, allReady, firstRunScreen, readyChecks } from "../lib/first-run";
import { STILL_ACTIONABLE_MS, unseen } from "../lib/kiosk";
import { bucketOf, isLate, orderFlag } from "../lib/order-display";
import { HISTORY_DAYS, countsForHistory, weekHistory } from "../lib/history";
import { dayLabel, localDayKey, recentDayKeys } from "../lib/local-day";
import type { Order } from "../lib/types";

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

const TZ = "America/Chicago";
const RESTAURANT = "22222222-2222-4222-8222-222222222222";
const SERIAL = "R8YL42BJPSB";
const H = 3_600_000;
const M = 60_000;
/** Wednesday 2026-09-16, 4:00 PM in Chicago (CDT, UTC-5). */
const AFTERNOON = Date.parse("2026-09-16T21:00:00Z");
const at = (ms: number) => new Date(ms).toISOString();

console.log("1. the shell hands the page a reference:");

let ref: string | null = null;
test("Hexnode's managed config put the serial on the start URL; a tablet without it self-registers by ANDROID_ID", () => {
  ref = readDeviceRef(`https://pfd-order-monitor.vercel.app/dashboard?shell=5&device=${SERIAL}`);
  assert.equal(ref, SERIAL);
  assert.equal(deviceRefKind(ref!), "managed");
  const aid = readDeviceRef("https://pfd-order-monitor.vercel.app/dashboard?shell=5&device=aid:9f1c2d3e4a5b6c7d");
  assert.equal(deviceRefKind(aid!), "android_id");
  assert.equal(readDeviceRef("https://pfd-order-monitor.vercel.app/dashboard?shell=5"), null, "no reference: the code path (step 3)");
});

console.log("\n2. bootstrap: unbound until the office assigns it, bound after, throttled on a reboot loop:");

test("a reference the bridge has never seen is unbound - and stays unbound while it sits in the CRM's 'new tablets seen' list", () => {
  const boot = AFTERNOON - 2 * H;
  assert.equal(bootstrapDecision(null, boot), "unbound");
  // Recorded with no restaurant; every 5 s poll gets the same answer, free.
  const seen = { device_ref: SERIAL, restaurant_id: null, last_bootstrap_at: null };
  assert.equal(bootstrapDecision(seen, boot), "unbound");
  assert.equal(bootstrapDecision(seen, boot + 5_000), "unbound");
  assert.equal(UNBOUND_VISIBLE_MS, 7 * 24 * H, "the office has a week to notice it");
});

test("the CRM pushes the binding (one entry on assign, the whole map after a sync); a bad entry refuses the whole push", () => {
  const one = parseBindings({ device_ref: SERIAL, restaurant_id: RESTAURANT, model: "SM-X133" });
  assert.deepEqual(one, [{ device_ref: SERIAL, restaurant_id: RESTAURANT, model: "SM-X133" }]);
  const map = parseBindings({ bindings: [{ device_ref: SERIAL, restaurant_id: RESTAURANT }, { device_ref: "aid:9f1c2d3e4a5b6c7d", restaurant_id: null }] });
  assert.equal(map?.length, 2);
  assert.equal(map?.[1].restaurant_id, null, "null = unbind (back to stock)");
  assert.equal(parseBindings({ bindings: [{ device_ref: "x", restaurant_id: RESTAURANT }] }), null, "a reference too short to be one");
  assert.equal(parseBindings({ bindings: [{ device_ref: SERIAL, restaurant_id: 42 }] }), null);
});

test("bound: the next poll mints a session; a reboot loop inside thirty seconds is throttled, and bound again after", () => {
  const boot = AFTERNOON - 2 * H + 30_000;
  const bound = { device_ref: SERIAL, restaurant_id: RESTAURANT, last_bootstrap_at: null };
  assert.equal(bootstrapDecision(bound, boot), "bound");
  const minted = { ...bound, last_bootstrap_at: at(boot) };
  assert.equal(bootstrapDecision(minted, boot + 5_000), "throttled", "a replayed reference does not mint a session a second");
  assert.equal(bootstrapDecision(minted, boot + BOOTSTRAP_MINT_MIN_INTERVAL_MS - 1), "throttled");
  assert.equal(bootstrapDecision(minted, boot + BOOTSTRAP_MINT_MIN_INTERVAL_MS), "bound");
  assert.equal(BOOTSTRAP_MINT_MIN_INTERVAL_MS, 30_000);
});

test("the per-address limit is generous enough for a kitchen of polling tablets and no more", () => {
  assert.equal(mayBootstrap(0), true);
  assert.equal(mayBootstrap(BOOTSTRAP_RATE_MAX - 1), true);
  assert.equal(mayBootstrap(BOOTSTRAP_RATE_MAX), false);
  assert.equal(mayBootstrap(1.5), false);
});

console.log("\n3. the last resort: a six-digit code read down the phone:");

test("the code is six uniform digits, one per tablet, thirty minutes for the office to act", () => {
  const rnd = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
  const code = generateLinkCode(rnd);
  assert.equal(code.length, 6);
  assert.ok(isLinkCode(code), code);
  assert.equal(isLinkCode("12345"), false);
  assert.equal(LINK_CODE_TTL_MS, 30 * M);
  assert.equal(mayCreateLinkCode(LINK_CODE_RATE_MAX - 1), true);
  assert.equal(mayCreateLinkCode(LINK_CODE_RATE_MAX), false);
});

test("pending -> linked by the office -> collected once, by the tablet it was issued to, even after the thirty minutes", () => {
  const issued = AFTERNOON - 90 * M;
  const row: LinkCodeRow = {
    code: "482913",
    device_id: "tablet-device-id-0123456789ab",
    expires_at: at(issued + LINK_CODE_TTL_MS),
    restaurant_id: null,
    linked_at: null,
    token_hash: null,
    consumed_at: null,
  };
  assert.equal(linkCodeState(row, issued + 5_000), "pending");
  assert.equal(mayCollect(row, row.device_id, issued + 5_000), false, "nothing to collect yet");
  // Minute 29: the office links it.
  const linked = { ...row, restaurant_id: RESTAURANT, linked_at: at(issued + 29 * M), token_hash: "pkce_abc" };
  assert.equal(linkCodeState(linked, issued + 29 * M), "linked");
  // Minute 31: the tablet notices - still good, the TTL is the office's, not the tablet's.
  assert.equal(linkCodeState(linked, issued + 31 * M), "linked");
  assert.equal(mayCollect(linked, "someone-elses-device-id-000000", issued + 31 * M), false, "a code overheard in a kitchen");
  assert.equal(mayCollect(linked, row.device_id, issued + 31 * M), true);
  const consumed = { ...linked, consumed_at: at(issued + 31 * M) };
  assert.equal(linkCodeState(consumed, issued + 32 * M), "consumed");
  assert.equal(mayCollect(consumed, row.device_id, issued + 32 * M), false, "once");
  // Never linked: expired at thirty minutes, and the tablet asks for a new one.
  assert.equal(linkCodeState(row, issued + LINK_CODE_TTL_MS), "expired");
  assert.equal(tokenHashFrom({ properties: { hashed_token: "pkce_abc" } }), "pkce_abc");
  assert.equal(tokenHashFrom({}), null);
});

console.log("\n4. first run: the Ready screen, three checks, then the orders:");

test("no session is Pairing; a session on a fresh device is Ready; a set-up device goes straight to the orders", () => {
  assert.equal(firstRunScreen({ sessionValid: false, setupDone: false }), "pairing");
  assert.equal(firstRunScreen({ sessionValid: true, setupDone: false }), "ready");
  assert.equal(firstRunScreen({ sessionValid: true, setupDone: true }), "orders");
});

test("Ready passes on connected + alerts on; the printer row is advisory; it moves on after twenty seconds", () => {
  const checking = readyChecks({ online: true, alertsOn: null, printer: { online: null } });
  assert.equal(allReady(checking), false, "unknown is not a tick");
  const paperOut = readyChecks({ online: true, alertsOn: true, printer: { online: false } });
  assert.equal(allReady(paperOut), true, "orders still show without paper");
  const alertsOff = readyChecks({ online: true, alertsOn: false, alertsWhy: "blocked", printer: null });
  assert.equal(allReady(alertsOff), false);
  assert.match(alertsOff[1].action!, /Call Premium/);
  assert.equal(READY_AUTO_ADVANCE_MS, 20_000);
});

console.log("\n5. the evening's orders: what chimes, what sits where:");

type O = {
  id: string;
  order_number: string;
  order_type: Order["order_type"];
  customer_name: string;
  customer_total: number;
  status: Order["status"];
  source: Order["source"];
  received_at: string;
  opened_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};
const order = (id: string, receivedMs: number, over: Partial<O> = {}): O => ({
  id,
  order_number: id.toUpperCase(),
  order_type: "delivery",
  customer_name: "A. Customer",
  customer_total: 24.5,
  status: "new",
  source: "zuppler",
  received_at: at(receivedMs),
  opened_at: null,
  accepted_at: null,
  completed_at: null,
  cancelled_at: null,
  ...over,
});

test("a new order chimes until somebody opens it; opened, cancelled and six-hour-old orders do not", () => {
  const now = AFTERNOON + 2 * H; // 6 PM
  const fresh = order("a1", now - 2 * M);
  const opened = order("a2", now - 4 * M, { status: "opened", opened_at: at(now - 3 * M) });
  const cancelled = order("a3", now - 5 * M, { status: "cancelled", cancelled_at: at(now - M) });
  const stale = order("a4", now - STILL_ACTIONABLE_MS, {});
  const ids = unseen([fresh, opened, cancelled, stale], now).map((o) => o.id);
  assert.deepEqual(ids, ["a1"]);
  assert.equal(isLate(fresh, now), false);
  assert.equal(isLate(order("a5", now - 11 * M), now), true, "ten minutes unopened is late");
  assert.equal(orderFlag(fresh)?.label !== undefined, true);
});

test("the three lists through one evening in Chicago: kitchen, Completed, and what has become yesterday", () => {
  const sixPm = AFTERNOON + 2 * H;
  const cooking = order("b1", sixPm - 20 * M, { status: "opened", opened_at: at(sixPm - 19 * M) });
  const done = order("b2", sixPm - H, { status: "completed", completed_at: at(sixPm - 30 * M) });
  const lunchDone = order("b3", AFTERNOON - 4 * H, { status: "completed", completed_at: at(AFTERNOON - 3 * H) });
  const forgotten = order("b4", sixPm - 7 * H); // never opened, past the chime window
  assert.equal(bucketOf(cooking, sixPm, TZ), "orders");
  assert.equal(bucketOf(done, sixPm, TZ), "completed");
  assert.equal(bucketOf(lunchDone, sixPm, TZ), "completed", "finished at noon is still today's Completed at six");
  assert.equal(bucketOf(forgotten, sixPm, TZ), "past", "an unopened order older than the chime window leaves the kitchen list");

  // 11:55 PM Chicago: an order completed at 11:50 PM is Completed...
  const lateNight = Date.parse("2026-09-17T04:55:00Z");
  const lastCall = order("b5", lateNight - 40 * M, { status: "completed", completed_at: at(lateNight - 5 * M) });
  assert.equal(bucketOf(lastCall, lateNight, TZ), "completed");
  // ...and at 8:00 AM Chicago the next morning it is yesterday's business.
  const morning = Date.parse("2026-09-17T13:00:00Z");
  assert.equal(bucketOf(lastCall, morning, TZ), "past");
  // Read in UTC, 11:50 PM Chicago on the 16th and 8 AM on the 17th are the
  // SAME day (both the 17th), so the ticket would still sit in Completed
  // at breakfast - which is why the zone is an input.
  assert.equal(bucketOf(lastCall, morning, "UTC"), "completed");
});

console.log("\n6. the week, by Chicago days:");

test("an order at 11:30 PM Chicago belongs to that day, not to the UTC date it was written under", () => {
  const key = localDayKey("2026-09-16T04:30:00Z", TZ); // 11:30 PM CDT on the 15th
  assert.equal(key, "2026-09-15");
  assert.equal(localDayKey("2026-09-16T04:30:00Z", "UTC"), "2026-09-16");
});

test("seven days, oldest first, ending Today; counts skip cancelled and test orders but still list them", () => {
  const now = AFTERNOON;
  const orders: O[] = [
    order("c1", now - 30 * M),
    order("c2", now - 2 * H, { status: "completed", completed_at: at(now - H), customer_total: 40 }),
    order("c3", Date.parse("2026-09-16T04:30:00Z"), { status: "completed", completed_at: at(Date.parse("2026-09-16T04:50:00Z")), customer_total: 10 }), // 11:30 PM on the 15th
    order("c4", now - 24 * H, { status: "cancelled", cancelled_at: at(now - 23 * H), customer_total: 99 }),
    order("c5", now - 24 * H - H, { source: "test", customer_total: 5 }),
    order("c6", now - 6 * 24 * H, { status: "completed", completed_at: at(now - 6 * 24 * H + H), customer_total: 12.25 }),
    order("c7", now - 9 * 24 * H, { status: "completed", completed_at: at(now - 9 * 24 * H + H) }), // outside the window
  ];
  const week = weekHistory(orders, now, TZ);
  assert.equal(week.length, HISTORY_DAYS);
  assert.deepEqual(week.map((d) => d.key), recentDayKeys(now, TZ, HISTORY_DAYS));
  assert.equal(week[6].key, "2026-09-16");
  assert.equal(week[6].label, "Today");
  assert.equal(week[5].label, "Yesterday");
  assert.equal(week[0].label, dayLabel(week[0].key, now, TZ));
  const today = week[6];
  assert.deepEqual(today.orders.map((o) => o.id), ["c1", "c2"], "newest first");
  assert.equal(today.count, 2);
  assert.equal(today.total, 24.5 + 40);
  const yesterday = week[5];
  assert.deepEqual(yesterday.orders.map((o) => o.id).sort(), ["c3", "c4", "c5"], "the 11:30 PM order is yesterday's; cancelled and test are listed");
  assert.equal(yesterday.count, 1, "but only the real one counts");
  assert.equal(yesterday.total, 10);
  assert.equal(countsForHistory({ status: "cancelled", source: "zuppler" }), false);
  assert.equal(countsForHistory({ status: "new", source: "test" }), false);
  assert.equal(week[0].orders.length, 1, "day -6 has c6");
  assert.equal(week.flatMap((d) => d.orders).some((o) => o.id === "c7"), false, "day -9 is not in the week");
});

test("the week is still seven distinct days across the clocks going back (2026-11-01 in Chicago)", () => {
  const now = Date.parse("2026-11-03T18:00:00Z"); // Tue noon CST, two days after DST ended
  const keys = recentDayKeys(now, TZ, HISTORY_DAYS);
  assert.equal(keys.length, 7);
  assert.equal(new Set(keys).size, 7);
  assert.deepEqual([keys[0], keys[6]], ["2026-10-28", "2026-11-03"]);
});

console.log(`\n${passed} assertions passed.`);
