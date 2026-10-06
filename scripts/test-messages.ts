/**
 * Messages between a restaurant tablet and dispatch (migration 048).
 *
 * Worth asserting: what a kitchen may send (quick picks need no words, plain
 * text does, an order problem must name an order), that "Where's my driver?"
 * attaches the newest open delivery, the rate limit, the unread count and
 * the "new reply" rule that keeps a reloaded tablet from chiming at an old
 * reply - and, by reading the routes, that the restaurant always comes from
 * the session or the CRM key and never from the request body.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_BODY,
  QUICK_PICKS,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  cleanBody,
  driverLateOrder,
  newReplies,
  overRateLimit,
  parseCrmReply,
  parseTabletMessage,
  unreadCount,
} from "@/lib/messages";

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
const src = (p: string) => readFileSync(p, "utf8");
const ORDER = "8d2a3c1e-5b6f-4a7d-9e0f-112233445566";

console.log("messages");

test("plain text must say something; quick picks fall back to their words", () => {
  assert.deepEqual(parseTabletMessage({ kind: "text", body: "  " }), { ok: false, error: "write a message first" });
  const d = parseTabletMessage({ kind: "driver_late" });
  assert.equal(d.ok && d.body, QUICK_PICKS.driver_late.defaultBody);
  const t = parseTabletMessage({ body: "Out of brisket" });
  assert.equal(t.ok && t.kind, "text");
});

test("an order problem must name a real-looking order id", () => {
  assert.deepEqual(parseTabletMessage({ kind: "order_problem" }), { ok: false, error: "pick the order first" });
  assert.deepEqual(parseTabletMessage({ kind: "order_problem", order_id: "1184" }), { ok: false, error: "bad order" });
  const ok = parseTabletMessage({ kind: "order_problem", order_id: ORDER, body: "Missing a side" });
  assert.equal(ok.ok && ok.orderId, ORDER);
});

test("a menu change is only what the restaurant writes", () => {
  assert.deepEqual(parseTabletMessage({ kind: "menu_change", body: " " }), { ok: false, error: "write what changed on the menu" });
  const m = parseTabletMessage({ kind: "menu_change", body: "Ribs are now $24.99\nOut of banana pudding" });
  assert.equal(m.ok && m.kind, "menu_change");
  assert.equal(m.ok && m.body, "Ribs are now $24.99\nOut of banana pudding");
});

test("migration allows every kind the tablet can send", () => {
  const sql = src("db/migrations/048_restaurant_messages.sql");
  for (const k of ["text", "driver_late", "order_problem", "menu_change"]) assert.match(sql, new RegExp(`'${k}'`));
});

test("unknown kinds and over-long bodies are refused", () => {
  assert.equal(parseTabletMessage({ kind: "refund_me" }).ok, false);
  assert.equal(parseTabletMessage({ body: "x".repeat(MAX_BODY + 1) }).ok, false);
});

test("control characters are stripped, newlines kept", () => {
  assert.equal(cleanBody("a\u0007b\r\nc"), "ab\nc");
});

test("Where's my driver? attaches the newest open delivery, never a pickup or a done one", () => {
  const o = (id: string, type: "pickup" | "delivery", status: string, at: string) => ({ id, order_type: type, status: status as any, received_at: at });
  const pick = driverLateOrder([
    o("a", "delivery", "opened", "2026-10-06T18:00:00Z"),
    o("b", "delivery", "opened", "2026-10-06T18:20:00Z"),
    o("c", "pickup", "opened", "2026-10-06T18:30:00Z"),
    o("d", "delivery", "completed", "2026-10-06T18:40:00Z"),
  ]);
  assert.equal(pick?.id, "b");
  assert.equal(driverLateOrder([o("c", "pickup", "opened", "2026-10-06T18:30:00Z")]), null);
});

test("rate limit: RATE_LIMIT in the window, older ones do not count", () => {
  const now = Date.parse("2026-10-06T19:00:00Z");
  const recent = Array.from({ length: RATE_LIMIT }, (_, i) => new Date(now - i * 1000).toISOString());
  assert.equal(overRateLimit(recent, now), true);
  assert.equal(overRateLimit(recent.slice(1), now), false);
  assert.equal(overRateLimit([...recent.slice(1), new Date(now - RATE_WINDOW_MS - 1).toISOString()], now), false);
});

test("unread counts dispatch replies not yet shown, nothing the kitchen wrote", () => {
  assert.equal(
    unreadCount([
      { direction: "to_restaurant", read_at: null },
      { direction: "to_restaurant", read_at: "2026-10-06T19:00:00Z" },
      { direction: "from_restaurant", read_at: null },
    ]),
    1
  );
});

test("a reloaded tablet does not chime for an old reply; a new one does", () => {
  const msgs = [{ id: "1", direction: "to_restaurant" as const }, { id: "2", direction: "from_restaurant" as const }];
  assert.deepEqual(newReplies(msgs, null), []);
  assert.deepEqual(newReplies([...msgs, { id: "3", direction: "to_restaurant" as const }], new Set(["1", "2"])), ["3"]);
});

test("a CRM reply needs a restaurant and words; ticket numbers lose their #", () => {
  assert.equal(parseCrmReply({ body: "hi" }).ok, false);
  assert.equal(parseCrmReply({ restaurant: "x", body: " " }).ok, false);
  const r = parseCrmReply({ restaurant: "acct-1", body: "Driver is 5 min out", author: "Kayla", ticket_no: "#1042" });
  assert.equal(r.ok && r.ticketNo, "1042");
  assert.equal(r.ok && r.author, "Kayla");
  const n = parseCrmReply({ restaurant: "acct-1", body: "ok", ticket_no: 7 });
  assert.equal(n.ok && n.ticketNo, "7");
});

console.log("routes");

test("tablet routes take the restaurant from the session, never the body", () => {
  for (const p of ["app/api/dashboard/messages/route.ts", "app/api/dashboard/messages/read/route.ts"]) {
    const s = src(p);
    assert.match(s, /auth\.getUser\(\)/, `${p} checks the session`);
    assert.match(s, /getCurrentUserRestaurantIds\(\)/, `${p} takes the restaurant from it`);
    assert.doesNotMatch(s, /restaurant_id:\s*(input|body|parsed)\./, `${p} never writes a body's restaurant`);
  }
});

test("a tablet can only attach its own restaurant's order", () => {
  assert.match(src("app/api/dashboard/messages/route.ts"), /\.eq\("id", parsed\.orderId\)\.eq\("restaurant_id", s\.restaurantId\)/);
});

test("both CRM verbs are behind the CRM write key", () => {
  const s = src("app/api/crm/messages/route.ts");
  assert.equal((s.match(/authorizeCrmWrite\(req\)/g) ?? []).length, 2);
});

test("the CRM feed never carries the customer's phone or address", () => {
  const s = src("app/api/crm/messages/route.ts");
  assert.doesNotMatch(s, /customer_phone|customer_address/);
});

test("the dashboard mounts the messages button", () => {
  assert.match(src("components/OrderDashboard.tsx"), /<DispatchMessages /);
});

console.log(`\n${passed} passed`);
