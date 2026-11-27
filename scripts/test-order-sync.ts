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
  POLL_OVERDUE_MS,
  RESYNC_MIN_GAP_MS,
  SW_ORDER_MESSAGE,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX_MS,
  SYNC_TIMEOUT_MS,
  advanceCursor,
  mergeOrders,
  ordersListView,
  pollConnection,
  pollOverdue,
  realtimeOrdersEnabled,
  sessionProbeResult,
  sessionVerdict,
  shouldResync,
  signInPath,
  syncFailureKind,
  syncFailureText,
  syncPlan,
  syncRetryDelayMs,
  withTimeout,
} from "../lib/order-sync";
import { ARM_AUDIO_WAIT_MS, audioStateOk } from "../lib/sound";
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

// HP1 (Tickets #1909, #1078, 2026-11-27): Historic Perk, running the order
// screen in Chrome on its own tablet, reported "no orders" / "cannot
// connect" after a refresh and no ring until a refresh.
console.log("\nHP1 - a signed-out screen never looks like a quiet kitchen:");

test("an answer is believed only with a session; without one the server is asked first", () => {
  assert.equal(sessionVerdict("present"), "sync");
  // No session in the browser: the database would answer "no rows" to
  // anybody, so nothing is read until the server has said who this is.
  assert.equal(sessionVerdict("absent"), "probe");
  assert.equal(sessionVerdict("absent", "signed_out"), "sign_in");
  assert.equal(sessionVerdict("absent", "unreachable"), "retry", "offline is not signed out");
  assert.equal(sessionVerdict("absent", "signed_in"), "sync", "a browser that cannot read its own cookie reads as it always did");
  // A session store that could not be read never signs a working screen out.
  assert.equal(sessionVerdict("unknown"), "retry");
  assert.equal(sessionVerdict("unknown", "signed_out"), "retry");
});

test("only a 401 from the server means signed out", () => {
  assert.equal(sessionProbeResult(401), "signed_out");
  assert.equal(sessionProbeResult(200), "signed_in");
  for (const s of [null, 0, 403, 404, 429, 500, 502, 503]) assert.equal(sessionProbeResult(s), "unreachable", String(s));
  const route = src("app/api/dashboard/session/route.ts");
  assert.match(route, /status: 401/);
  assert.match(route, /status: 503/, "the sign-in service failing is not 'signed out'");
  assert.doesNotMatch(route, /from\(/, "it reads the session and nothing else");
});

test("signed out goes to sign-in: the kitchen tablet where a reload already sends it, a computer to the username form", () => {
  assert.equal(signInPath("kitchen"), "/link?next=%2Fdashboard");
  assert.equal(signInPath(null), "/link?next=%2Fdashboard", "not known yet is the kitchen - a Hexnode kiosk signs itself back in at /link");
  assert.equal(signInPath("remote"), "/login?next=%2Fdashboard");
  // The same place the middleware sends /dashboard with no session.
  assert.match(src("middleware.ts"), /url\.pathname = path\.startsWith\("\/admin"\) \? "\/login" : "\/link";/);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /if \(verdict === "probe"\) verdict = sessionVerdict\(browser, await probeSession\(\)\);/);
  assert.match(dash, /if \(verdict === "sign_in"\) return goSignIn\(\);/);
  assert.match(dash, /window\.location\.assign\(signInPath\(roleRef\.current\)\)/);
  assert.match(dash, /fetch\("\/api\/dashboard\/session", \{ cache: "no-store", signal: abort\.signal \}\)/);
  // The check comes BEFORE the read: a signed-out read is never applied.
  assert.ok(dash.indexOf("const browser = await readBrowserSession();") < dash.indexOf('let query = supabase.from("orders")'));
  assert.match(dash, /This screen was signed out/);
});

test("the empty list shows only when the server really answered with no orders", () => {
  assert.equal(ordersListView({ count: 0, confirmed: true, offline: false }), "empty");
  assert.equal(ordersListView({ count: 0, confirmed: false, offline: false }), "unconfirmed", "no real answer yet");
  assert.equal(ordersListView({ count: 0, confirmed: true, offline: true }), "unconfirmed", "the feed is down: 'no orders' is not known");
  assert.equal(ordersListView({ count: 3, confirmed: false, offline: true }), "orders", "orders already on screen stay, so the kitchen can finish them");
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /const listView = ordersListView\(\{ count: kitchen\.length, confirmed: listConfirmed, offline \}\);/);
  assert.match(dash, /\{listView === "empty" && \(\s*<div className="app-empty">Nothing in the kitchen\./);
  assert.match(dash, /listView === "empty" \? \([\s\S]{0,160}All clear/, "and so does 'All clear'");
  assert.match(dash, /setSyncFailure\(null\);\s*setListConfirmed\(true\);/, "confirmed by a successful read");
  assert.match(dash, /useState\(initialOrdersOk\)/);
  assert.match(src("app/dashboard/page.tsx"), /initialOrdersOk=\{!ordersError && Array\.isArray\(orders\)\}/);
});

console.log("\nHP1 - a failed sync says what failed and tries again:");

test("the failure is named: no internet, too slow, a server error, or a refused sign-in", () => {
  assert.equal(syncFailureKind({ status: 0, message: "TypeError: Failed to fetch" }), "network");
  assert.equal(syncFailureKind({ status: 0, message: "AbortError: signal is aborted without reason" }), "timeout");
  assert.equal(syncFailureKind({ status: 500, message: "internal" }), "server");
  assert.equal(syncFailureKind({ status: 503, message: "" }, false), "network", "the browser says it is offline");
  assert.equal(syncFailureKind({ status: 401, message: "JWT expired", code: "PGRST303" }), "auth");
  assert.equal(syncFailureKind({ status: 400, code: "PGRST301", message: "" }), "auth");
  assert.equal(syncFailureKind(null), "network");
  assert.match(syncFailureText({ kind: "network" }), /No internet connection/);
  assert.match(syncFailureText({ kind: "timeout" }), /too slow/);
  assert.match(syncFailureText({ kind: "server", status: 502 }), /answered with an error \(502\)/);
  assert.match(syncFailureText({ kind: "auth" }), /sign-in/);
  assert.match(syncFailureText(null), /could not get the orders/);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /className="offline-why">\{syncFailureText\(syncFailure\)\}/);
  assert.match(dash, /onClick=\{\(\) => void sync\("full"\)\}>\s*Try again now/, "and a button, so nobody has to refresh the page to retry");
});

test("retries back off - about 3 s, 6 s, 12 s - then the 15 s down-poll carries on", () => {
  assert.equal(syncRetryDelayMs(0), null, "nothing failed");
  assert.equal(syncRetryDelayMs(1, seq(0.5)), SYNC_RETRY_BASE_MS);
  assert.equal(syncRetryDelayMs(2, seq(0.5)), 2 * SYNC_RETRY_BASE_MS);
  assert.equal(syncRetryDelayMs(3, seq(0.5)), 4 * SYNC_RETRY_BASE_MS);
  assert.equal(syncRetryDelayMs(4, seq(0.5)), null, "from here the ordinary poll is the retry");
  assert.equal(syncRetryDelayMs(40, seq(0.5)), null);
  assert.ok(4 * SYNC_RETRY_BASE_MS < SYNC_RETRY_MAX_MS && SYNC_RETRY_MAX_MS <= POLL_DOWN_MS, "a backoff never waits longer than the down-poll would");
  // Jittered, so a fleet that lost the same server does not return in step.
  assert.equal(syncRetryDelayMs(1, seq(0)), 2400);
  assert.equal(syncRetryDelayMs(1, seq(1)), 3600);
  assert.equal(syncRetryDelayMs(1, seq(9)), 3600, "a bad rand is clamped");
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /const wait = syncRetryDelayMs\(pollFailuresRef\.current\);\s*if \(wait !== null && !leavingRef\.current\) retryTimerRef\.current = setTimeout\(\(\) => void syncRef\.current\?\.\(\), wait\);/);
});

test("no read can hang: the order read is aborted, and every other wait is bounded", () => {
  assert.ok(SYNC_TIMEOUT_MS > 0 && SYNC_TIMEOUT_MS <= POLL_DOWN_MS, "a hung read is over before the next down-poll");
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /const timer = setTimeout\(\(\) => abort\.abort\(\), SYNC_TIMEOUT_MS\);\s*try \{\s*return await query\.limit\(200\)\.abortSignal\(abort\.signal\);/);
  assert.match(dash, /withTimeout\(supabaseBrowser\(\)\.auth\.getSession\(\), SYNC_TIMEOUT_MS, null\)/);
  assert.match(dash, /withTimeout\(supabase\.auth\.refreshSession\(\), SYNC_TIMEOUT_MS, null\)/);
});

test("a 401 refreshes the session and reads once more; only the server can call it signed out", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /=== "auth"\) \{[\s\S]*?refreshSession\(\)[\s\S]*?if \(refreshed && !refreshed\.error && refreshed\.data\.session\) res = await read\(\);\s*else if \(\(await probeSession\(\)\) === "signed_out"\) return goSignIn\(\);/);
  // The heartbeat is the other place the server says "nobody is signed in".
  assert.match(dash, /if \(res\.status === 401\) \{\s*void withTimeout\(supabaseBrowser\(\)\.auth\.refreshSession\(\), SYNC_TIMEOUT_MS, null\)\.then\(\(\) => syncRef\.current\?\.\(\)\);/);
});

console.log("\nHP1 - the list catches up by itself, and one sync runs at a time:");

test("back online, back in focus, or restored from the back/forward cache: a full pull", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /const onOnline = \(\) => void sync\("full"\);/);
  assert.match(dash, /window\.addEventListener\("online", onOnline\);/);
  assert.match(dash, /window\.addEventListener\("focus", onFocus\);/);
  assert.match(dash, /if \(e\.persisted\) void sync\("full"\);/);
  // Focus arrives with visibilitychange; it does not pull twice.
  assert.equal(shouldResync(null, NOW), true);
  assert.equal(shouldResync(NOW - RESYNC_MIN_GAP_MS + 1, NOW), false);
  assert.equal(shouldResync(NOW - RESYNC_MIN_GAP_MS, NOW), true);
});

test("a poll that has stopped even trying is restarted", () => {
  assert.equal(POLL_OVERDUE_MS, 3 * POLL_ONLY_MS);
  assert.ok(POLL_OVERDUE_MS > 1.2 * POLL_LIVE_MS, "never trips on an ordinary jittered wait, Realtime on or off");
  assert.equal(pollOverdue(null, NOW), false, "nothing has started yet - the first sync is on its way");
  assert.equal(pollOverdue(NOW - POLL_OVERDUE_MS + 1, NOW), false);
  assert.equal(pollOverdue(NOW - POLL_OVERDUE_MS, NOW), true);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /if \(document\.visibilityState === "visible" && pollOverdue\(lastAttemptRef\.current, Date\.now\(\)\)\) void sync\(\);/);
  assert.match(dash, /lastAttemptRef\.current = now;/);
});

test("a second ask while a sync is running is queued, never run on top of it", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /if \(syncBusyRef\.current\) \{\s*syncQueuedRef\.current = force === "full" \|\| syncQueuedRef\.current === "full" \? "full" : "any";\s*return;/);
  assert.match(dash, /if \(!queued \|\| leavingRef\.current\) break;/);
});

// Async, so it is awaited before the count at the bottom is printed.
const settled = (async () => {
  const name = "withTimeout answers in time whatever the promise does, and never rejects";
  try {
    assert.equal(await withTimeout(Promise.resolve("ok"), 50, "late"), "ok");
    assert.equal(await withTimeout(new Promise(() => {}), 10, "late"), "late", "a promise that never settles");
    assert.equal(await withTimeout(Promise.reject(new Error("boom")), 50, "late"), "late", "a rejection is the fallback, not a throw");
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
})();

console.log("\nHP1 - sound that cannot play says so:");

test("only a running audio context will chime", () => {
  assert.equal(audioStateOk("running"), true);
  for (const s of ["suspended", "interrupted", "closed", "", null, undefined]) assert.equal(audioStateOk(s), false, String(s));
});

test("the sound check answers even when the browser leaves resume() pending, and notices audio switched off later", () => {
  const sound = src("lib/sound.ts");
  // A browser that wants a touch first may never settle resume(); the check
  // used to wait on it for ever and the screen never said sound was off.
  assert.match(sound, /await Promise\.race\(\[c\.resume\(\), new Promise<void>\(\(resolve\) => setTimeout\(resolve, ARM_AUDIO_WAIT_MS\)\)\]\);/);
  assert.ok(ARM_AUDIO_WAIT_MS > 0 && ARM_AUDIO_WAIT_MS <= 3_000);
  assert.match(sound, /c\.addEventListener\("statechange", handler\);/);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /const unsubscribe = onAudioStateChange\(seen\);/);
  assert.match(dash, /if \(isAudioArmed\(\) !== soundSeenRef\.current\) seen\(isAudioArmed\(\)\);/);
  assert.match(dash, /setSoundArmed\(ok\);\s*setSoundChecked\(true\);/);
});

test("sound off is one full-width bar that is itself the tap", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /\{!soundArmed && \(\s*<button type="button" className="kiosk-banner kiosk-critical sound-bar" role="alert" onClick=\{\(\) => void turnSoundOn\(\)\}>\s*Tap to turn on order sound\s*<\/button>/);
  assert.match(dash, /const ok = await armAudio\(\);\s*setSoundArmed\(ok\);\s*setSoundChecked\(true\);\s*if \(ok\) playChime\(\);/, "and the room hears that it worked");
  assert.match(src("app/globals.css"), /\.sound-bar \{ display: block; width: 100%;/);
});

test("the tradeoff is written down where the capacity numbers live", () => {
  const doc = src("docs/scale-500.md");
  assert.match(doc, /NEXT_PUBLIC_REALTIME_ORDERS/);
  assert.match(doc, /opt-in/i);
  assert.match(doc, /incremental/i);
});

void settled.then(() => console.log(`\n${passed} assertions passed.`));
