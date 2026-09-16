/**
 * Orders arrive by poll, not by socket (Nick, 2026-09-16).
 *
 * Supabase Pro allows 500 Realtime connections and the fleet is heading for
 * 500 tablets, so Realtime is opt-in and off by default. What has to be
 * true for that not to be a downgrade: the poll is cheap (incremental), a
 * push still makes the list move at once, the pill tells the truth from
 * the poll alone, and turning Realtime back on is one env var.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FULL_SYNC_EVERY_MS,
  POLL_FAILURES_BEFORE_DOWN,
  POLL_ONLY_MS,
  SW_ORDER_MESSAGE,
  advanceCursor,
  mergeOrders,
  pollConnection,
  realtimeOrdersEnabled,
  syncPlan,
} from "../lib/order-sync";
import { POLL_DOWN_MS, POLL_LIVE_MS, pollDelayMs } from "../lib/kiosk";

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
const NOW = Date.parse("2026-09-16T23:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const seq = (v: number) => () => v;

console.log("realtime is opt-in:");

test("off unless the build says so, and only the plain spellings count", () => {
  assert.equal(realtimeOrdersEnabled({}), false);
  assert.equal(realtimeOrdersEnabled({ NEXT_PUBLIC_REALTIME_ORDERS: "" }), false);
  assert.equal(realtimeOrdersEnabled({ NEXT_PUBLIC_REALTIME_ORDERS: "0" }), false);
  assert.equal(realtimeOrdersEnabled({ NEXT_PUBLIC_REALTIME_ORDERS: "false" }), false);
  for (const on of ["1", "true", "on", "yes", " TRUE "]) assert.equal(realtimeOrdersEnabled({ NEXT_PUBLIC_REALTIME_ORDERS: on }), true, on);
});

test("the channel is only opened behind the flag, and the poll is the feed either way", () => {
  const dash = src("components/OrderDashboard.tsx");
  const rt = dash.slice(dash.indexOf("// --- Realtime, opt-in"), dash.indexOf("// --- Poll, always"));
  assert.match(rt, /if \(!realtimeOrdersEnabled\(\)\) return;[\s\S]*?\.channel\(`orders-\$\{restaurantId\}`\)/, "no flag, no channel");
  assert.match(dash, /pollDelayMs\(connection, Math\.random, realtimeOrdersEnabled\(\) \? undefined : POLL_ONLY_MS\)/);
  assert.match(src(".env.example"), /NEXT_PUBLIC_REALTIME_ORDERS=/);
});

console.log("\nthe poll carries the orders:");

test("thirty seconds when it is the only feed, sixty as a backstop, fifteen when down", () => {
  assert.equal(POLL_ONLY_MS, 30_000);
  assert.equal(pollDelayMs("live", seq(0.5), POLL_ONLY_MS), 30_000);
  assert.equal(pollDelayMs("live", seq(0.5)), POLL_LIVE_MS);
  assert.equal(pollDelayMs("down", seq(0.5), POLL_ONLY_MS), POLL_DOWN_MS);
  // Still jittered: five hundred tablets must not share a second.
  assert.equal(pollDelayMs("live", seq(0), POLL_ONLY_MS), 24_000);
  assert.equal(pollDelayMs("live", seq(1), POLL_ONLY_MS), 36_000);
});

test("full on first load, incremental after, full again once an hour", () => {
  assert.equal(syncPlan({ cursor: null, lastFullAt: null, now: NOW }), "full");
  assert.equal(syncPlan({ cursor: iso(NOW - 1000), lastFullAt: null, now: NOW }), "full", "a cursor without a full pull behind it is not trusted");
  assert.equal(syncPlan({ cursor: iso(NOW - 1000), lastFullAt: NOW - 10 * 60_000, now: NOW }), "incremental");
  assert.equal(syncPlan({ cursor: iso(NOW - 1000), lastFullAt: NOW - FULL_SYNC_EVERY_MS, now: NOW }), "full");
  assert.equal(FULL_SYNC_EVERY_MS, 60 * 60_000);
});

test("the cursor comes from the rows, never from the tablet's clock", () => {
  assert.equal(advanceCursor(null, []), null);
  assert.equal(advanceCursor(null, [{ updated_at: iso(NOW - 5000) }, { updated_at: iso(NOW - 1000) }]), iso(NOW - 1000));
  assert.equal(advanceCursor(iso(NOW - 500), [{ updated_at: iso(NOW - 1000) }]), iso(NOW - 500), "older rows do not move it back");
  assert.equal(advanceCursor(iso(NOW - 500), [{ updated_at: null }, { updated_at: "junk" }]), iso(NOW - 500));
  const lib = src("lib/order-sync.ts");
  assert.doesNotMatch(lib.slice(lib.indexOf("export function advanceCursor")), /Date\.now\(\)/);
});

test("changed rows replace their old selves, new ones join, newest-received first, capped", () => {
  const o = (id: string, receivedMs: number, status = "new") => ({ id, received_at: iso(receivedMs), status });
  const prev = [o("b", NOW - 1000), o("a", NOW - 2000)];
  const merged = mergeOrders(prev, [o("a", NOW - 2000, "completed"), o("c", NOW - 500)]);
  assert.deepEqual(merged.map((x) => x.id), ["c", "b", "a"]);
  assert.equal(merged.find((x) => x.id === "a")!.status, "completed");
  assert.equal(mergeOrders(prev, []), prev, "nothing changed returns the same list, no re-render");
  const many = Array.from({ length: 205 }, (_, i) => o(`o${i}`, NOW - i * 1000));
  assert.equal(mergeOrders([], many).length, 200);
});

test("the dashboard asks for updated_at past the cursor, ascending, and full pulls newest-received first", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /query\.gt\("updated_at", cursorRef\.current as string\)\.order\("updated_at", \{ ascending: true \}\)/);
  assert.match(dash, /query\.order\("received_at", \{ ascending: false \}\)/);
  assert.match(dash, /cursorRef\.current = advanceCursor\(cursorRef\.current, rows\)/);
  assert.match(dash, /setOrders\(\(prev\) => mergeOrders\(prev, rows\)\)/);
  // A failure forgets the last full pull, so the next success is a full one.
  assert.match(dash, /pollFailuresRef\.current \+= 1;\s*lastFullAtRef\.current = null;/);
  // Foreground and a reconnected socket both force a full pull.
  assert.match(dash, /if \(document\.visibilityState === "visible"\) void sync\("full"\)/);
  assert.match(dash, /if \(next === "live"\) void sync\("full"\)/);
});

test("migration 039: updated_at backfilled to received_at, trigger on update, index the poll uses", () => {
  const m = src("db/migrations/039_orders_updated_at.sql");
  assert.match(m, /add column if not exists updated_at timestamptz/);
  assert.match(m, /set updated_at = coalesce\(updated_at, received_at, now\(\)\)/);
  assert.match(m, /before update on orders/);
  assert.match(m, /new\.updated_at = now\(\)/);
  assert.match(m, /create index if not exists idx_orders_restaurant_updated_at\s+on orders \(restaurant_id, updated_at desc\)/);
  assert.match(src("lib/types.ts"), /updated_at\?: string \| null;/);
});

console.log("\nthe pill tells the truth from the poll alone:");

test("connecting until the first result, live after a success, down after two failures", () => {
  assert.equal(pollConnection({ everSucceeded: false, failures: 0 }), "connecting");
  assert.equal(pollConnection({ everSucceeded: false, failures: 1 }), "connecting");
  assert.equal(pollConnection({ everSucceeded: true, failures: 0 }), "live");
  assert.equal(pollConnection({ everSucceeded: true, failures: 1 }), "live", "one blip is not an outage");
  assert.equal(pollConnection({ everSucceeded: true, failures: 2 }), "down");
  assert.equal(pollConnection({ everSucceeded: false, failures: 2 }), "down");
  assert.equal(POLL_FAILURES_BEFORE_DOWN, 2);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /if \(!realtimeOrdersEnabled\(\)\) setConnection\(pollConnection\(\{ everSucceeded: true, failures: 0 \}\)\)/);
  assert.match(dash, /if \(!realtimeOrdersEnabled\(\)\) setConnection\(pollConnection\(\{ everSucceeded: pollEverOkRef\.current, failures: pollFailuresRef\.current \}\)\)/);
});

console.log("\na push still moves the list at once:");

test("the worker tells every open page, and the page syncs on the message", () => {
  const sw = src("public/sw.js");
  assert.match(sw, /clients\s*\.matchAll\(\{ type: "window", includeUncontrolled: true \}\)\s*\.then\(\(pages\) => pages\.forEach\(\(p\) => p\.postMessage\(\{ type: "premium:order"/);
  assert.equal(SW_ORDER_MESSAGE, "premium:order");
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /navigator\.serviceWorker\.addEventListener\("message", onMessage\)/);
  assert.match(dash, /if \(e\.data\?\.type === SW_ORDER_MESSAGE\) void sync\(\)/);
});

test("the tradeoff is written down where the capacity numbers live", () => {
  const doc = src("docs/scale-500.md");
  assert.match(doc, /NEXT_PUBLIC_REALTIME_ORDERS/);
  assert.match(doc, /opt-in/i);
  assert.match(doc, /incremental/i);
});

console.log(`\n${passed} assertions passed.`);
