/**
 * PFD's touchscreen order box (lib/orderbox.ts, lib/orderbox-server.ts):
 * the request rules, the reply the box parses, today's numbers, screenshots,
 * and a whole kitchen session run through every handler against an
 * in-memory database.
 */
import assert from "node:assert/strict";
import {
  boxReply,
  boxText,
  commandToSend,
  decodeShot,
  encodeShot,
  isOrderBoxPrinterName,
  orderLine,
  parseBoxCommand,
  parseBoxRequest,
  parseDriverPush,
  printerStatusText,
  todaySummary,
  type BoxOrderRow,
} from "@/lib/orderbox";
import { eatabitPrinterName, isEatabitPrinterName, isTextOnlyPrinter } from "@/lib/printers/text-only";
import { kitchenAlerts } from "@/lib/kitchen-alerts";
import { evaluateHealth } from "@/lib/health";
import * as box from "@/lib/orderbox-server";

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; }
  };
  pending.push(pending.length ? pending[pending.length - 1].then(run) : run());
}
const form = (o: Record<string, string>) => new URLSearchParams(o);

console.log("order box:");

// --- text and replies -------------------------------------------------------------

test("box text is plain ASCII with no pipes or newlines", () => {
  assert.equal(boxText("José’s “big” plate | 2\nnow"), `Jose's "big" plate 2 now`);
  assert.equal(boxText("Café — ½ off…"), "Cafe - 1/2 off...");
  assert.equal(boxText("🍔 burger"), "burger");
  assert.equal(boxText("x".repeat(50), 10), "xxxxxxxxx.");
  assert.equal(boxText(null), "");
});

test("a reply is key=value lines with ok first", () => {
  assert.equal(boxReply([["ok", 1], ["a", "b"], ["n", null], ["t", true], ["skip", undefined]]), "ok=1\na=b\nn=\nt=1\n");
});

const row = (o: Partial<BoxOrderRow> = {}): BoxOrderRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  order_number: "Z-1001",
  ticket_no: 12,
  source: "zuppler",
  order_type: "delivery",
  status: "printed",
  received_at: "2026-11-25T18:00:00.000Z",
  due_time: null,
  accepted_at: null,
  ready_by: null,
  ready_at: null,
  customer_name: "Dana Smith",
  items: [{ name: "Burger" }, { name: "Fries" }],
  driver_name: null,
  driver_status: null,
  driver_eta_at: null,
  kitchen_denied_at: null,
  ...o,
});

test("an order line has sixteen fields in the documented order", () => {
  const f = orderLine(row({ accepted_at: "2026-11-25T18:01:00Z", ready_by: "2026-11-25T18:21:00Z", driver_name: "Mike Jones", driver_status: "assigned", driver_eta_at: "2026-11-25T18:15:00Z" })).split("|");
  assert.equal(f.length, 16);
  assert.equal(f[1], "12", "the ticket number, not the order number");
  assert.equal(f[5], "1");
  assert.equal(f[6], String(Date.parse("2026-11-25T18:21:00Z") / 1000));
  assert.equal(f[8], "Mike");
  assert.equal(f[9], "assigned");
  assert.equal(f[12], "Dana", "first name only");
  assert.equal(f[13], "2");
  assert.equal(orderLine(row({ ticket_no: null })).split("|")[1], "Z-1001");
});

// --- today's numbers -------------------------------------------------------------

test("today counts real orders, food sales, the top item and the average", () => {
  const t = todaySummary([
    { source: "zuppler", status: "printed", items_total: "20.00", items: [{ name: "2x Burger" }, { name: "Fries" }] },
    { source: "phone", status: "completed", items_total: 10, items: [{ name: "Burger" }] },
    { source: "zuppler", status: "cancelled", items_total: "99", items: [{ name: "Steak" }] },
    { source: "test", status: "printed", items_total: "50", items: [{ name: "Steak" }] },
    { source: "email", status: "printed", items_total: null, items: [] },
  ]);
  assert.deepEqual(t, { orders: 3, salesCents: 3000, topItem: "Burger", avgCents: 1500 });
  assert.deepEqual(todaySummary([]), { orders: 0, salesCents: 0, topItem: "", avgCents: 0 });
});

// --- requests ----------------------------------------------------------------------

const OID = "22222222-2222-4222-8222-222222222222";

test("requests parse, and anything off is refused with a reason", () => {
  assert.deepEqual(parseBoxRequest(form({ Action: "Sync" })), { ok: true, req: { action: "Sync" } });
  assert.deepEqual(parseBoxRequest(form({ Action: "Ack", Order: OID })), { ok: true, req: { action: "Ack", orderId: OID, minutes: null } });
  assert.deepEqual(parseBoxRequest(form({ Action: "Ack", Order: OID, Minutes: "20" })), { ok: true, req: { action: "Ack", orderId: OID, minutes: 20 } });
  assert.equal(parseBoxRequest(form({ Action: "Ack", Order: OID, Minutes: "0" })).ok, false);
  assert.equal(parseBoxRequest(form({ Action: "Ack", Order: OID, Minutes: "abc" })).ok, false);
  assert.equal(parseBoxRequest(form({ Action: "Ack", Order: "not-a-uuid" })).ok, false);
  assert.equal(parseBoxRequest(form({ Action: "Late", Order: OID, Add: "7" })).ok, false);
  assert.deepEqual(parseBoxRequest(form({ Action: "Late", Order: OID, Add: "10" })), { ok: true, req: { action: "Late", orderId: OID, add: 10 } });
  assert.deepEqual(parseBoxRequest(form({ Action: "Busy", End: "1" })), { ok: true, req: { action: "Busy", end: true } });
  assert.deepEqual(parseBoxRequest(form({ Action: "Busy", Add: "15", For: "60" })), { ok: true, req: { action: "Busy", end: false, minutes: 15, lengthMinutes: 60 } });
  assert.equal(parseBoxRequest(form({ Action: "Pause", For: "45" })).ok, false);
  assert.deepEqual(parseBoxRequest(form({ Action: "Pause", For: "today" })), { ok: true, req: { action: "Pause", end: false, choice: "today" } });
  assert.equal(parseBoxRequest(form({ Action: "Msg", Kind: "anything" })).ok, false);
  assert.equal(parseBoxRequest(form({ Action: "Msg", Kind: "call_me", Order: "x" })).ok, false);
  assert.deepEqual(parseBoxRequest(form({ Action: "Msg", Kind: "wheres_driver" })), { ok: true, req: { action: "Msg", key: "wheres_driver", orderId: null } });
  assert.equal(parseBoxRequest(form({ Action: "Item86", Ref: "bad ref!", Out: "1" })).ok, false);
  assert.deepEqual(parseBoxRequest(form({ Action: "Item86", Ref: "itm_9", Out: "1" })), { ok: true, req: { action: "Item86", ref: "itm_9", soldOut: true } });
  assert.equal(parseBoxRequest(form({ Action: "Deny", Order: OID, Code: "BORED" })).ok, false);
  assert.deepEqual(parseBoxRequest(form({ Action: "Health", Printer: "paper_low", Link: "backup" })), { ok: true, req: { action: "Health", printer: "paper_low", link: "backup" } });
  assert.equal(parseBoxRequest(form({ Action: "Health", Printer: "on fire" })).ok, false);
  assert.equal(parseBoxRequest(form({ Action: "Shot", W: "4000", H: "240" })).ok, false);
  assert.equal(parseBoxRequest(form({ Action: "Drop tables" })).ok, false);
});

test("the CRM may queue reboot, screenshot or reprint with a number", () => {
  assert.deepEqual(parseBoxCommand({ command: "reboot" }), { ok: true, command: "reboot" });
  assert.deepEqual(parseBoxCommand({ command: "reprint", order_number: 42 }), { ok: true, command: "reprint:42" });
  assert.equal(parseBoxCommand({ command: "reprint" }).ok, false);
  assert.equal(parseBoxCommand({ command: "format" }).ok, false);
});

test("a command goes out once, again after five quiet minutes, never after a day or once done", () => {
  const t = Date.parse("2026-11-25T18:00:00Z");
  const d = { box_command: "reboot", box_command_at: new Date(t).toISOString(), box_command_sent_at: null as string | null, box_command_done_at: null as string | null };
  assert.equal(commandToSend(d, t + 1000), "reboot");
  assert.equal(commandToSend({ ...d, box_command_sent_at: new Date(t + 1000).toISOString() }, t + 60_000), null);
  assert.equal(commandToSend({ ...d, box_command_sent_at: new Date(t + 1000).toISOString() }, t + 6 * 60_000), "reboot");
  assert.equal(commandToSend({ ...d, box_command_done_at: new Date(t).toISOString() }, t + 1000), null);
  assert.equal(commandToSend(d, t + 25 * 3600_000), null);
});

test("the driver push takes a first name, a status and an optional ETA", () => {
  assert.deepEqual(parseDriverPush(null), { ok: true, clear: true });
  assert.deepEqual(parseDriverPush({ name: "Mike Jones", status: "assigned", eta_at: "2026-11-25T18:15:00Z" }), { ok: true, clear: false, name: "Mike", status: "assigned", etaAt: "2026-11-25T18:15:00.000Z" });
  assert.equal(parseDriverPush({ name: "Mike", status: "lost" }).ok, false);
  assert.equal(parseDriverPush({ status: "assigned" }).ok, false);
  assert.equal(parseDriverPush({ name: "Mike", status: "assigned", eta_at: "soon" }).ok, false);
});

// --- screenshots ----------------------------------------------------------------

test("a screenshot round-trips through the box's run-length encoding", () => {
  const w = 40, h = 24;
  const px = new Uint16Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = i < 300 ? 0xf800 : i % 7 === 0 ? 0x07e0 : 0x001f;
  const enc = encodeShot(px);
  assert.ok(enc.length < px.length * 2, "flat screens compress");
  const rgba = decodeShot(enc, w, h);
  assert.deepEqual([...rgba.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...rgba.slice(302 * 4, 302 * 4 + 4)], [0, 0, 255, 255]);
  assert.deepEqual([...rgba.slice(301 * 4, 301 * 4 + 4)], [0, 255, 0, 255]);
  assert.throws(() => decodeShot(enc, w, h + 1), /expected/);
  assert.throws(() => decodeShot(Uint8Array.from([0, 0, 0]), 1, 1), /zero-length/);
  const png = box.pngOf(rgba, w, h);
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

// --- naming and health ------------------------------------------------------------

test("the order box keeps the Eatabit name and adds its own", () => {
  const n = eatabitPrinterName("pfd-eatabit/1.1.0 orderbox");
  assert.equal(n, "PFD Eatabit 1.1.0 Order Box");
  assert.ok(isEatabitPrinterName(n) && isOrderBoxPrinterName(n));
  assert.ok(isTextOnlyPrinter("pfd-eatabit/1.1.0 orderbox"));
  assert.equal(eatabitPrinterName("pfd-eatabit/2.9.1"), "PFD Eatabit 2.9.1");
  assert.ok(!isOrderBoxPrinterName("PFD Eatabit 2.9.1"));
});

test("paper status words", () => {
  assert.equal(printerStatusText("ok"), null);
  assert.equal(printerStatusText("paper_out"), "Out of paper");
});

const NOW = new Date("2026-11-25T18:30:00Z");
const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const emptySnap = (): any => ({
  devices: [], inboxes: [], restaurantsWithoutDevice: [], pendingJobs: [], failedJobs: [], unreconciledOrders: [], unsentEmailJobs: [],
  undeliveredAppAlerts: [], restaurantsWithoutAppDevice: [], tabletsNotWatching: [], unacceptedOrders: [],
  webhook: { lastReceiptAt: at(5), lastAcceptedAt: at(5), recentTotal: 3, recentRejected: 0, recentWindowHours: 6, recentRejectedSources: [] },
  cronRuns: [{ job: "gmail_poll", last_run_at: at(1) }, { job: "monitor_check", last_run_at: at(5) }],
  restaurantVolumes: [],
});

test("health: low paper warns, out of paper is critical, and the kitchen sees both", () => {
  const snap = emptySnap();
  snap.devices = [
    { id: "d1", name: "Box", restaurant_id: "r1", restaurant_name: "Joe's", is_active: true, last_seen_at: NOW.toISOString(), printer_status: "paper_low" },
    { id: "d2", name: "Box 2", restaurant_id: "r1", restaurant_name: "Joe's", is_active: true, last_seen_at: NOW.toISOString(), printer_status: "paper_out" },
    { id: "d3", name: "Epson", restaurant_id: "r1", restaurant_name: "Joe's", is_active: true, last_seen_at: NOW.toISOString(), printer_status: null },
  ];
  const issues = evaluateHealth(snap, NOW) as any[];
  const paper = issues.filter((i) => i.key.startsWith("printer_paper:"));
  assert.equal(paper.length, 2);
  assert.equal(paper.find((i) => i.key === "printer_paper:d1")?.severity, "warning");
  assert.equal(paper.find((i) => i.key === "printer_paper:d2")?.severity, "critical");
  const k = kitchenAlerts(issues, "r1");
  assert.ok(k.some((a) => /paper/i.test(a.title)), "the kitchen tablet shows it");
});

test("health: an order nobody tapped GOT IT on is called out as the box's", () => {
  const snap = emptySnap();
  snap.unacceptedOrders = [{ id: "o1", order_number: "12", restaurant_id: "r1", restaurant_name: "Joe's", received_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(), due_time: null, on_box: true }];
  const issues = evaluateHealth(snap, NOW) as any[];
  const i = issues.find((x) => x.key === "order_unaccepted:o1");
  assert.ok(i && i.severity === "critical" && /GOT IT on the order box/.test(i.detail));
});

// --- a whole session against an in-memory database --------------------------------

type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>) {
  const log: string[] = [];
  const t = (name: string) => (tables[name] ??= []);
  function builder(table: string, op: "select" | "update" | "insert" | "upsert", payload?: any, opts?: any) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN = Infinity;
    let orderBy: { col: string; asc: boolean } | null = null;
    let wantRows = op === "select";
    const run = () => {
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: `${table}-${t(table).length + 1}`, created_at: new Date().toISOString(), ...p }));
        t(table).push(...rows);
        log.push(`insert ${table}`);
        return { data: wantRows ? rows : null, error: null };
      }
      if (op === "upsert") {
        const key = "device_id" in payload ? "device_id" : "id";
        const at = t(table).findIndex((r) => r[key] === payload[key]);
        if (at >= 0) t(table)[at] = { ...t(table)[at], ...payload }; else t(table).push({ ...payload });
        log.push(`upsert ${table}`);
        return { data: null, error: null };
      }
      let rows = t(table).filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        rows.forEach((r) => Object.assign(r, payload));
        if (rows.length) log.push(`update ${table} ${Object.keys(payload).join(",")}`);
        return { data: wantRows ? rows.map((r) => ({ ...r })) : null, error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      rows = rows.slice(0, limitN);
      if (opts?.head) return { data: null, count: rows.length, error: null };
      return { data: rows.map((r) => ({ ...r })), count: rows.length, error: null };
    };
    const b: any = {
      select(_c?: string, o?: any) { wantRows = true; if (o) opts = { ...opts, ...o }; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] >= v); return b; },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      order(c: string, o?: { ascending?: boolean }) { orderBy = { col: c, asc: o?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      single() { const r = run(); const d = Array.isArray(r.data) ? r.data[0] : r.data; return Promise.resolve(d ? { data: d, error: null } : { data: null, error: { message: "no rows" } }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  return {
    log,
    tables,
    admin: () => ({
      from: (table: string) => ({
        select: (c?: string, o?: any) => builder(table, "select", undefined, o),
        update: (p: Row) => builder(table, "update", p),
        insert: (p: Row) => builder(table, "insert", p),
        upsert: (p: Row) => builder(table, "upsert", p),
      }),
      rpc: async () => ({ data: 0, error: null }),
    }),
  };
}

const R = "33333333-3333-4333-8333-333333333333";
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function session() {
  const db = fakeDb({
    print_devices: [{ id: "dev1", restaurant_id: R, device_key: "PFD-KEY", is_active: true, box_command: null, box_command_at: null, box_command_sent_at: null, box_command_done_at: null }],
    restaurants: [{ id: R, name: "Joe’s Grill", timezone: "America/Chicago", prep_minutes: 20, box_promo: "Try the brisket", online_paused_until: null, online_pause_reason: null, online_paused_at: null, busy_boost_minutes: null, busy_started_at: null, busy_until: null, busy_started_by: null, cook_max_boost_minutes: null, cook_max_busy_minutes: null, cook_band_min: null, cook_band_max: null }],
    restaurant_profiles: [],
    orders: [
      { ...row({ id: "aaaaaaaa-0000-4000-8000-000000000001", ticket_no: 1, received_at: minsAgo(3), status: "printed" }), restaurant_id: R, ready_minutes: null, items_total: "18.50" },
      { ...row({ id: "aaaaaaaa-0000-4000-8000-000000000002", ticket_no: 2, source: "ubereats", received_at: minsAgo(1), status: "printed" }), restaurant_id: R, ready_minutes: null, items_total: "30.00" },
      { ...row({ id: "aaaaaaaa-0000-4000-8000-000000000003", ticket_no: 3, source: "test", received_at: minsAgo(1) }), restaurant_id: R, ready_minutes: null, items_total: "5" },
      { ...row({ id: "aaaaaaaa-0000-4000-8000-000000000009", ticket_no: 9, received_at: minsAgo(2) }), restaurant_id: "someone-else", ready_minutes: null, items_total: "5" },
    ],
    restaurant_messages: [{ id: "m1", restaurant_id: R, direction: "to_restaurant", kind: "text", body: "Driver is 5 min out", author: "Forrest", created_at: minsAgo(1), read_at: null }],
    restaurant_menus: [{ restaurant_id: R, crm_menu_id: "menu1", source: "crm", pushed_at: minsAgo(600), menu: { categories: [{ ref: "c1", name: "Mains", items: [{ ref: "itm_1", name: "Brisket Plate", price_cents: 1500, available: true, description: null }] }] } }],
    cook_time_log: [],
    device_screens: [],
  });
  box.useBoxBackendForTests(db.admin, (async () => ({ queued: [{ device_id: "dev1" }] })) as any);
  return db;
}
const O1 = "aaaaaaaa-0000-4000-8000-000000000001";
const O2 = "aaaaaaaa-0000-4000-8000-000000000002";
const FOREIGN = "aaaaaaaa-0000-4000-8000-000000000009";
const lines = (body: string) => body.trim().split("\n");
const val = (body: string, key: string) => lines(body).find((l) => l.startsWith(key + "="))?.slice(key.length + 1);

test("session: sync lists today's real orders with the restaurant's state", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  assert.ok(dev);
  assert.equal(await box.findBoxDevice("nope"), null);
  const r = await box.boxSync(dev);
  assert.equal(r.status, 200);
  assert.equal(val(r.body, "ok"), "1");
  assert.equal(val(r.body, "name"), "Joe's Grill");
  assert.equal(val(r.body, "prep"), "20");
  assert.equal(val(r.body, "busy"), "0");
  assert.equal(val(r.body, "paused"), "0");
  assert.equal(val(r.body, "unread"), "1");
  assert.equal(val(r.body, "promo"), "Try the brisket");
  assert.match(val(r.body, "today")!, /^2\|4850\|2425\|/);
  const os = lines(r.body).filter((l) => l.startsWith("o="));
  assert.equal(os.length, 2, "no test order, no other restaurant's order");
  assert.match(lines(r.body).find((l) => l.startsWith("msg="))!, /\|0\|Forrest\|Driver is 5 min out$/);
  assert.ok(!r.body.includes("cmd="));
  void db;
});

test("session: GOT IT accepts with the prep target, once", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  const r = await box.boxAck(dev, O1, null);
  assert.equal(val(r.body, "ok"), "1");
  const o = db.tables.orders.find((x) => x.id === O1)!;
  assert.ok(o.accepted_at);
  assert.equal(o.ready_minutes, 20);
  const again = await box.boxAck(dev, O1, null);
  assert.equal(val(again.body, "already"), "1");
  const foreign = await box.boxAck(dev, FOREIGN, null);
  assert.equal(foreign.status, 404, "another restaurant's order is not found");
});

test("session: running late moves the ready time and logs it; READY stamps once", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  assert.equal((await box.boxLate(dev, O1, 5)).status, 409, "accept first");
  await box.boxAck(dev, O1, 15);
  const before = Date.parse(db.tables.orders.find((x) => x.id === O1)!.ready_by);
  const late = await box.boxLate(dev, O1, 10);
  assert.equal(val(late.body, "ok"), "1");
  const after = Date.parse(db.tables.orders.find((x) => x.id === O1)!.ready_by);
  assert.ok(after - before >= 10 * 60_000 - 1000);
  assert.equal(db.tables.cook_time_log.length, 1);
  assert.equal(db.tables.cook_time_log[0].actor, "Order box");
  assert.equal(val((await box.boxReady(dev, O1)).body, "ok"), "1");
  assert.ok(db.tables.orders.find((x) => x.id === O1)!.ready_at);
  assert.equal(val((await box.boxReady(dev, O1)).body, "already"), "1");
  assert.equal((await box.boxLate(dev, O1, 5)).status, 409, "ready orders cannot be re-timed");
});

test("session: a prep time picked on the box accepts with it", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  await box.boxPrep(dev, O1, 30);
  assert.equal(db.tables.orders.find((x) => x.id === O1)!.ready_minutes, 30);
  await box.boxPrep(dev, O1, 45);
  assert.equal(db.tables.orders.find((x) => x.id === O1)!.ready_minutes, 45, "and re-times after");
});

test("session: deny works only for an unaccepted Uber Eats order", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  assert.equal((await box.boxDeny(dev, O1, "CAPACITY")).status, 409);
  const r = await box.boxDeny(dev, O2, "CAPACITY");
  assert.equal(val(r.body, "ok"), "1");
  const o = db.tables.orders.find((x) => x.id === O2)!;
  assert.ok(o.kitchen_denied_at);
  assert.equal(o.kitchen_deny_code, "CAPACITY");
  const sync = await box.boxSync(dev);
  const line = lines(sync.body).find((l) => l.startsWith(`o=${O2}`))!;
  assert.equal(line.split("|")[11], "1", "the box sees it denied");
});

test("session: busy adds to the prep target until ended; it can't stack", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  const r = await box.boxBusy(dev, { action: "Busy", end: false, minutes: 15, lengthMinutes: 60 });
  assert.equal(val(r.body, "ok"), "1");
  assert.equal(db.tables.restaurants[0].busy_boost_minutes, 15);
  assert.equal(db.tables.restaurants[0].busy_started_by, "Order box");
  assert.equal(val((await box.boxSync(dev)).body, "prep"), "35");
  assert.equal((await box.boxBusy(dev, { action: "Busy", end: false, minutes: 10, lengthMinutes: 30 })).status, 409);
  assert.equal((await box.boxBusy(dev, { action: "Busy", end: false, minutes: 90, lengthMinutes: 30 })).status, 400, "over the limit");
  await box.boxBusy(dev, { action: "Busy", end: true });
  assert.equal(db.tables.restaurants[0].busy_boost_minutes, null);
  assert.deepEqual(db.tables.cook_time_log.map((l) => l.kind), ["boost_start", "boost_end"]);
});

test("session: pause tells dispatch, resume turns it back on", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  const r = await box.boxPause(dev, { action: "Pause", end: false, choice: "30" });
  assert.equal(val(r.body, "ok"), "1");
  assert.ok(db.tables.restaurants[0].online_paused_until);
  const msg = db.tables.restaurant_messages.find((m) => m.kind === "pause")!;
  assert.match(msg.body, /Paused online orders for 30 minutes/);
  assert.notEqual(val((await box.boxSync(dev)).body, "paused"), "0");
  await box.boxPause(dev, { action: "Pause", end: true });
  assert.equal(db.tables.restaurants[0].online_paused_until, null);
  assert.equal(db.tables.restaurant_messages.filter((m) => m.kind === "pause").length, 2);
});

test("session: quick messages reach dispatch and replies get marked read", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  await box.boxMessage(dev, "wheres_driver", O1);
  const m = db.tables.restaurant_messages.find((x) => x.kind === "driver_late")!;
  assert.equal(m.order_id, O1);
  assert.equal(m.author, "Order box");
  assert.equal((await box.boxMessage(dev, "call_me", FOREIGN)).status, 404);
  await box.boxRead(dev);
  assert.ok(db.tables.restaurant_messages.find((x) => x.id === "m1")!.read_at);
  for (let i = 0; i < 12; i++) await box.boxMessage(dev, "call_me", null);
  assert.equal((await box.boxMessage(dev, "call_me", null)).status, 429, "a stuck finger is rate limited");
});

test("session: 86 lists the menu and sends a sold-out change", async () => {
  const db = session();
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  const menu = await box.boxMenu(dev);
  assert.equal(val(menu.body, "cat"), "Mains");
  assert.equal(val(menu.body, "item"), "itm_1|1|0|Brisket Plate");
  const r = await box.boxItem86(dev, "itm_1", true);
  assert.equal(val(r.body, "ok"), "1");
  const msg = db.tables.restaurant_messages.find((x) => x.kind === "menu_change")!;
  assert.equal(msg.menu_changes.changes[0].action, "sold_out");
  assert.equal(val((await box.boxMenu(dev)).body, "item"), "itm_1|1|1|Brisket Plate", "now pending");
  assert.equal((await box.boxItem86(dev, "itm_nope", true)).status, 400);
});

test("session: health, a remote command and a screenshot", async () => {
  const db = session();
  let dev = (await box.findBoxDevice("PFD-KEY"))!;
  await box.boxHealth(dev, "paper_low", "backup");
  assert.equal(db.tables.print_devices[0].printer_status, "paper_low");
  assert.equal(db.tables.print_devices[0].box_link, "backup");
  Object.assign(db.tables.print_devices[0], { box_command: "screenshot", box_command_at: new Date().toISOString() });
  dev = (await box.findBoxDevice("PFD-KEY"))!;
  assert.equal(val((await box.boxSync(dev)).body, "cmd"), "screenshot");
  dev = (await box.findBoxDevice("PFD-KEY"))!;
  assert.equal(val((await box.boxSync(dev)).body, "cmd"), undefined, "sent once");
  const px = new Uint16Array(400 * 240).fill(0x1234);
  const shot = await box.boxShot(dev, encodeShot(px), 400, 240);
  assert.equal(val(shot.body, "ok"), "1");
  assert.equal(db.tables.device_screens.length, 1);
  assert.match(db.tables.device_screens[0].png, /^\\x89504e47/);
  assert.equal((await box.boxShot(dev, encodeShot(px), 400, 200)).status, 400);
  await box.boxDone(dev, "screenshot", "sent");
  assert.ok(db.tables.print_devices[0].box_command_done_at);
  assert.equal(val((await box.boxReprint(dev, O1)).body, "queued"), "1");
});

test("session: the CRM's driver push writes only when it changed", async () => {
  const db = session();
  const push = { clear: false, name: "Mike", status: "assigned", etaAt: "2026-11-25T18:15:00.000Z" };
  assert.deepEqual(await box.setOrderDriver(O1, push), { changed: true });
  assert.deepEqual(await box.setOrderDriver(O1, { ...push, etaAt: "2026-11-25T18:15:00Z" }), { changed: false });
  assert.deepEqual(await box.setOrderDriver(O1, { ...push, status: "at_pickup" }), { changed: true });
  const dev = (await box.findBoxDevice("PFD-KEY"))!;
  const f = lines((await box.boxSync(dev)).body).find((l) => l.startsWith(`o=${O1}`))!.split("|");
  assert.deepEqual([f[8], f[9], f[10]], ["Mike", "at_pickup", String(Date.parse(push.etaAt) / 1000)]);
  assert.deepEqual(await box.setOrderDriver(O1, { clear: true }), { changed: true });
  assert.equal(db.tables.orders.find((x) => x.id === O1)!.driver_name, null);
});

Promise.all(pending).then(() => {
  console.log(`${passed} passed`);
});
