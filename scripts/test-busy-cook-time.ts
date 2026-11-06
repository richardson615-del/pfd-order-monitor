/**
 * BT1 (prs-crm QUEUE row 241, Ticket #948): busy-time cook time.
 *
 * Worth asserting: the limits are refused by the rules the routes run, not by
 * the screen; a boost ends on its own; Accept during a boost stamps ready_by
 * with it; every change writes a log row; the "what changed" read returns tablet
 * and CRM changes in order, including an expiry written late; and, by reading the
 * routes, that each one takes the restaurant from the session and writes the log.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_COOK_LIMITS,
  acceptMinutes,
  boostChoices,
  boostEndLog,
  boostLengthChoices,
  boostStartLog,
  busyEndsAt,
  busyLine,
  cookLimitsOf,
  cookTimeChoices,
  defaultChangeLog,
  lengthLabel,
  liveBusy,
  nextCloseAt,
  parseBusyRequest,
  parseCookLimits,
  parseKitchenCookTime,
  runningLateLog,
} from "@/lib/cook-time";
import { actorOf, cookSourceOf, endBusy, logCursorOf, logLimitOf, readActiveBusy, readCookTimeChanges, recordCookTimeChange } from "@/lib/cook-time-data";
import { readyByFor, readyChoices } from "@/lib/ready-timer";
import { shapeOrderRow, type OrderRowInput } from "@/lib/crm-orders";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
}
const src = (p: string) => readFileSync(p, "utf8");
const errorCode = (d: { kind: string; code?: string }) => (d.kind === "error" ? d.code : null);

/** A cook_time_log / restaurants stand-in: enough of the query builder to run the real reads against rows. */
function fakeAdmin(tables: Record<string, any[]>) {
  const writes: { table: string; op: string; value: unknown }[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let update: Record<string, unknown> | null = null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b),
      gt: (c: string, v: any) => ((rows = rows.filter((r) => r[c] > v)), b),
      gte: (c: string, v: any) => ((rows = rows.filter((r) => r[c] >= v)), b),
      in: (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b),
      order: (c: string, o: { ascending: boolean }) => ((rows = rows.sort((x, y) => (x[c] < y[c] ? -1 : 1) * (o.ascending ? 1 : -1))), b),
      limit: (n: number) => ((rows = rows.slice(0, n)), b),
      update: (v: Record<string, unknown>) => ((update = v), b),
      insert: (v: unknown) => {
        writes.push({ table, op: "insert", value: v });
        return Promise.resolve({ error: null });
      },
      then: (ok: (r: unknown) => void) => {
        if (update) {
          for (const r of rows) Object.assign(r, update);
          writes.push({ table, op: "update", value: update });
        }
        return ok({ data: rows, error: null });
      },
    };
    return b;
  };
  return { from, writes };
}

const NOW = Date.parse("2026-11-06T22:00:00Z"); // 4:00 PM in Chicago, a Friday
const R = "rest-1";

async function main() {
  console.log("limits");

  await test("the brief's limits are the defaults, and the buttons match them", () => {
    assert.deepEqual(DEFAULT_COOK_LIMITS, { max_boost_minutes: 30, max_length_minutes: 120, band_min: 10, band_max: 45 });
    assert.deepEqual(boostChoices(DEFAULT_COOK_LIMITS), [10, 15, 20, 30]);
    assert.deepEqual(boostLengthChoices(DEFAULT_COOK_LIMITS), [30, 60, 120]);
    assert.deepEqual(cookTimeChoices(DEFAULT_COOK_LIMITS), [10, 15, 20, 25, 30, 45]);
  });

  await test("+45 and 3 h are refused, whatever the screen sent", () => {
    assert.equal(errorCode(parseBusyRequest({ minutes: 45, length_minutes: 60 })), "boost_too_big");
    assert.equal(errorCode(parseBusyRequest({ minutes: 15, length_minutes: 180 })), "busy_too_long");
    for (const bad of [{ minutes: 0, length_minutes: 60 }, { minutes: "15", length_minutes: 60 }, { minutes: 1.5, length_minutes: 60 }, { minutes: 15 }, {}, null]) {
      assert.equal(parseBusyRequest(bad).kind, "error");
    }
    assert.deepEqual(parseBusyRequest({ minutes: 30, length_minutes: 120 }), { kind: "start", minutes: 30, lengthMinutes: 120 });
    assert.deepEqual(parseBusyRequest({ end: true }), { kind: "end" });
  });

  await test("a default of 90 is refused with who to ask; the picks still go through", () => {
    const d = parseKitchenCookTime({ prep_minutes: 90 });
    assert.equal(errorCode(d), "outside_band");
    assert.match(d.kind === "error" ? d.error : "", /Ask dispatch to change it/);
    assert.equal(errorCode(parseKitchenCookTime({ prep_minutes: 5 })), "outside_band");
    assert.deepEqual(parseKitchenCookTime({ prep_minutes: 45 }), { kind: "ok", minutes: 45 });
    assert.equal(errorCode(parseKitchenCookTime({ prep_minutes: 21 })), "invalid_cook_time");
  });

  await test("a restaurant's own limits replace the defaults, on the buttons and in the refusals", () => {
    const limits = cookLimitsOf({ cook_max_boost_minutes: 45, cook_max_busy_minutes: 90, cook_band_min: 5, cook_band_max: 60 });
    assert.deepEqual(parseBusyRequest({ minutes: 45, length_minutes: 90 }, limits), { kind: "start", minutes: 45, lengthMinutes: 90 });
    assert.deepEqual(boostChoices(limits), [10, 15, 20, 30, 45]);
    assert.deepEqual(boostLengthChoices(limits), [30, 60, 90]);
    assert.deepEqual(parseKitchenCookTime({ prep_minutes: 60 }, limits), { kind: "ok", minutes: 60 });
    const tighter = cookLimitsOf({ cook_max_boost_minutes: 15, cook_band_max: 30 });
    assert.equal(errorCode(parseBusyRequest({ minutes: 20, length_minutes: 60 }, tighter)), "boost_too_big");
    assert.equal(errorCode(parseKitchenCookTime({ prep_minutes: 45 }, tighter)), "outside_band");
    assert.deepEqual(boostChoices(tighter), [10, 15]);
  });

  await test("the CRM's limits are validated; null goes back to the default; others are kept", () => {
    const d = parseCookLimits({ max_boost_minutes: 45, band_max: null }, { cook_max_busy_minutes: 90, cook_band_max: 60 });
    assert.deepEqual(d, { kind: "ok", columns: { cook_max_boost_minutes: 45, cook_max_busy_minutes: 90, cook_band_min: null, cook_band_max: null } });
    for (const bad of [{ max_boost_minutes: 0 }, { max_boost_minutes: 121 }, { max_length_minutes: 721 }, { band_max: 181 }, { band_min: 1.5 }, { band_min: 50 }, {}, null, []]) {
      assert.equal(parseCookLimits(bad, null).kind, "error", JSON.stringify(bad));
    }
  });

  console.log("a boost ends on its own");

  const row = { busy_boost_minutes: 15, busy_started_at: new Date(NOW - 60_000).toISOString(), busy_until: new Date(NOW + 3_600_000).toISOString(), busy_started_by: "firecrackers" };

  await test("it counts until busy_until and not a moment after, with or without the sweep", () => {
    assert.equal(liveBusy(row, NOW)?.minutes, 15);
    assert.equal(liveBusy(row, Date.parse(row.busy_until)), null);
    assert.equal(liveBusy(row, Date.parse(row.busy_until) + 1), null);
    assert.equal(liveBusy({}, NOW), null);
    assert.equal(liveBusy(null, NOW), null);
  });

  const week = { friday: [{ open: "11:00", close: "21:00" }], saturday: [{ open: "16:00", close: "02:00" }], sunday: [] };

  await test("it ends at close when close comes first, and at the chosen length otherwise", () => {
    const at = (iso: string) => new Date(iso);
    // 8:30 PM Friday in Chicago, closing at 9:00 PM: a 1 h boost stops at 9.
    const late = at("2026-11-07T02:30:00Z");
    const close = nextCloseAt(week, late, "America/Chicago");
    assert.equal(close?.toISOString(), "2026-11-07T03:00:00.000Z");
    assert.equal(busyEndsAt(late, 60, close).toISOString(), "2026-11-07T03:00:00.000Z");
    // 4:00 PM: close is hours off, so the length decides.
    const early = at("2026-11-06T22:00:00Z");
    assert.equal(busyEndsAt(early, 60, nextCloseAt(week, early, "America/Chicago")).toISOString(), "2026-11-06T23:00:00.000Z");
  });

  await test("a range past midnight still closes it; closed or no hours on file leaves the length", () => {
    // 1:00 AM Sunday in Chicago is still Saturday's 16:00-02:00.
    const lateNight = new Date("2026-11-08T07:00:00Z");
    assert.equal(nextCloseAt(week, lateNight, "America/Chicago")?.toISOString(), "2026-11-08T08:00:00.000Z");
    assert.equal(nextCloseAt(week, new Date("2026-11-06T15:00:00Z"), "America/Chicago"), null); // 9 AM, before opening
    assert.equal(nextCloseAt(null, new Date(NOW), "America/Chicago"), null);
    assert.equal(nextCloseAt({ friday: "nonsense" }, new Date(NOW), "America/Chicago"), null);
  });

  await test("the sweep clears and logs in one statement, service role only, dated when it ended", () => {
    const sql = src("db/migrations/058_busy_cook_time.sql");
    assert.match(sql, /create or replace function expire_busy_boosts\(\)/);
    assert.match(sql, /'boost_expire', 'system'/);
    assert.match(sql, /revoke all on function expire_busy_boosts\(\) from public, anon, authenticated/);
    assert.match(sql, /grant execute on function expire_busy_boosts\(\) to service_role/);
    assert.match(sql, /alter table cook_time_log enable row level security/);
    assert.doesNotMatch(sql, /create policy/);
    assert.match(src("app/api/monitor/check/route.ts"), /await sweepExpiredBusy\(admin\)/);
  });

  console.log("Accept during a boost");

  await test("Accept pre-selects default + boost, and is back to the default after", () => {
    assert.equal(acceptMinutes(25, liveBusy(row, NOW)), 40);
    assert.equal(acceptMinutes(25, liveBusy(row, Date.parse(row.busy_until))), 25);
    assert.equal(acceptMinutes(170, { minutes: 30 }), 180, "never past what orders.ready_minutes allows");
    assert.ok(readyChoices(40).includes(40), "the pre-selected time is one of the buttons");
  });

  await test("the Accept route stamps ready_by with the boost when the kitchen keeps the pre-selected time", () => {
    const route = src("app/api/orders/[id]/route.ts");
    assert.match(route, /minutes = acceptMinutes\(prepMinutesOf\(r\?\.prep_minutes\), liveBusy\(r, Date\.now\(\)\)\)/);
    assert.match(route, /readyBy = readyByFor\(now, minutes\)/);
    assert.match(route, /ready_minutes: minutes, ready_by: readyBy/);
    const accepted = "2026-11-06T22:00:00.000Z";
    assert.equal(readyByFor(accepted, acceptMinutes(25, { minutes: 15 })), "2026-11-06T22:40:00.000Z");
  });

  const orderInput: OrderRowInput = {
    id: "o1", order_number: "1196", source: "zuppler", status: "printed", restaurant_id: R, received_at: "2026-11-06T21:55:00.000Z", opened_at: null,
    accepted_at: "2026-11-06T22:00:00.000Z", ready_minutes: 40, ready_by: "2026-11-06T22:40:00.000Z", ready_at: null, completed_at: null, cancelled_at: null, printed_at: null,
    due_time: null, order_type: "delivery", payment_type: null, channel_id: null, customer_name: null, customer_phone: null, items: [], customer_total: null,
  };

  await test("the order feed names the minutes in force, boost included, for a reader with no ready_by", () => {
    const shape = (o: OrderRowInput) => shapeOrderRow(o, { id: R, crm_restaurant_id: null, name: null, prep_minutes: 25 }, [], NOW);
    assert.equal(shape(orderInput).minutes_in_force, 40);
    assert.equal(shape(orderInput).prep_minutes, 25, "prep_minutes stays the restaurant's default");
    assert.equal(shape({ ...orderInput, ready_minutes: null, ready_by: null }).minutes_in_force, 25, "an order from before 055");
    assert.equal(shape({ ...orderInput, accepted_at: null, ready_minutes: null, ready_by: null }).minutes_in_force, null, "not accepted yet");
  });

  console.log("the log");

  const who = { source: "tablet" as const, actor: "firecrackers" };

  await test("a log row carries what each kind means", () => {
    assert.deepEqual(defaultChangeLog(R, 25, 35, who), { restaurant_id: R, kind: "default_change", source: "tablet", actor: "firecrackers", before_minutes: 25, after_minutes: 35 });
    const until = "2026-11-06T23:00:00.000Z";
    assert.deepEqual(boostStartLog(R, 25, 15, until, who), { restaurant_id: R, kind: "boost_start", source: "tablet", actor: "firecrackers", before_minutes: 25, after_minutes: 40, boost_minutes: 15, expires_at: until });
    assert.deepEqual(boostEndLog(R, 25, { minutes: 15, until }, { source: "crm", actor: "dana" }), { restaurant_id: R, kind: "boost_end", source: "crm", actor: "dana", before_minutes: 40, after_minutes: 25, boost_minutes: 15, expires_at: until });
  });

  await test("a Running-late bump writes a row naming the order and how far it moved", () => {
    const order = { id: "o1", restaurant_id: R, order_number: "1196", ready_by: "2026-11-06T22:40:00.000Z" };
    const log = runningLateLog(order, "2026-11-06T22:50:00.000Z", { source: "partner_app", actor: "Pat" });
    assert.equal(log.kind, "running_late");
    assert.equal(log.order_id, "o1");
    assert.equal(log.order_number, "1196");
    assert.equal(log.before_ready_by, "2026-11-06T22:40:00.000Z");
    assert.equal(log.after_ready_by, "2026-11-06T22:50:00.000Z");
    assert.equal(log.minutes_added, 10);
    assert.equal(runningLateLog({ ...order, ready_by: null }, "2026-11-06T22:50:00.000Z", who).minutes_added, null);
    const route = src("app/api/orders/[id]/route.ts");
    assert.match(route, /recordCookTimeChange\(\s*supabaseAdmin\(\),\s*runningLateLog\(order, data\.ready_by/);
  });

  await test("who: tablet by cookie, PFD Partner by Bearer; a tablet login by its username", () => {
    assert.equal(cookSourceOf(null), "tablet");
    assert.equal(cookSourceOf(`Bearer ${"a".repeat(40)}`), "partner_app");
    assert.equal(actorOf({ id: "u1", email: "real@example.com" }), "real@example.com");
    assert.equal(actorOf({ id: "u1" }), "u1");
    assert.equal(actorOf(null), null);
    assert.match(src("lib/store-session.ts"), /actor: actorOf\(user\)/);
  });

  await test("a failed log write is reported, and never thrown at the kitchen", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const failing = { from: () => ({ insert: async () => ({ error: { message: "nope" } }) }) };
      assert.equal(await recordCookTimeChange(failing, defaultChangeLog(R, 25, 35, who)), false);
      const throwing = { from: () => ({ insert: async () => { throw new Error("down"); } }) };
      assert.equal(await recordCookTimeChange(throwing, defaultChangeLog(R, 25, 35, who)), false);
    } finally {
      console.error = original;
    }
  });

  await test("every writer of a cook time logs it, and a no-change write does not", () => {
    const tablet = src("app/api/dashboard/store/cook-time/route.ts");
    assert.match(tablet, /if \(before !== d\.minutes\)/);
    assert.match(tablet, /recordCookTimeChange\(admin, defaultChangeLog\(/);
    const crm = src("app/api/crm/restaurants/[id]/route.ts");
    assert.match(crm, /updates\.prep_minutes !== prepMinutesOf\(restaurant\.prep_minutes\)/);
    assert.match(crm, /source: "crm", actor/);
    assert.match(src("app/api/dashboard/store/busy/route.ts"), /recordCookTimeChange\(admin, boostStartLog\(/);
  });

  console.log("what changed since");

  const logRows = [
    { id: 1, restaurant_id: R, kind: "boost_start", source: "tablet", actor: "firecrackers", created_at: "2026-11-06T22:00:00.000Z" },
    { id: 2, restaurant_id: "rest-2", kind: "default_change", source: "crm", actor: "dana", created_at: "2026-11-06T22:01:00.000Z" },
    { id: 3, restaurant_id: R, kind: "running_late", source: "tablet", actor: "firecrackers", created_at: "2026-11-06T22:02:00.000Z" },
    // Written after id 3, dated before it: an expiry the sweep noticed late.
    { id: 4, restaurant_id: R, kind: "boost_expire", source: "system", actor: null, created_at: "2026-11-06T22:00:30.000Z" },
  ];
  const restaurants = [
    { id: R, crm_restaurant_id: "crm-1", name: "Firecracker's" },
    { id: "rest-2", crm_restaurant_id: null, name: "Other" },
  ];

  await test("tablet and CRM changes come back in order, across restaurants, named both ways", async () => {
    const r = await readCookTimeChanges(fakeAdmin({ cook_time_log: logRows, restaurants }), {});
    assert.deepEqual(r.changes.map((c) => [c.id, c.source]), [[1, "tablet"], [2, "crm"], [3, "tablet"], [4, "system"]]);
    assert.deepEqual(r.changes[0]!.restaurant, { id: R, crm_restaurant_id: "crm-1", name: "Firecracker's" });
    assert.equal(r.next_after, 4);
    assert.equal(r.has_more, false);
  });

  await test("the cursor is the id, so an expiry written late is not skipped", async () => {
    const r = await readCookTimeChanges(fakeAdmin({ cook_time_log: logRows, restaurants }), { after: 3 });
    assert.deepEqual(r.changes.map((c) => c.kind), ["boost_expire"]);
  });

  await test("nothing new keeps the cursor; a page says there is more; one restaurant filters", async () => {
    const admin = () => fakeAdmin({ cook_time_log: logRows, restaurants });
    const none = await readCookTimeChanges(admin(), { after: 4 });
    assert.deepEqual([none.changes.length, none.next_after, none.has_more], [0, 4, false]);
    const page = await readCookTimeChanges(admin(), { after: 0, limit: 2 });
    assert.deepEqual([page.changes.map((c) => c.id), page.next_after, page.has_more], [[1, 2], 2, true]);
    const one = await readCookTimeChanges(admin(), { restaurantId: "rest-2" });
    assert.deepEqual(one.changes.map((c) => c.id), [2]);
    const since = await readCookTimeChanges(admin(), { since: "2026-11-06T22:01:00.000Z" });
    assert.deepEqual(since.changes.map((c) => c.id), [2, 3]);
  });

  await test("query strings: a bad cursor is null, a limit is capped", () => {
    assert.equal(logCursorOf("12"), 12);
    assert.equal(logCursorOf("0"), 0);
    for (const bad of [null, "", "-1", "1.5", "abc"]) assert.equal(logCursorOf(bad), null);
    assert.equal(logLimitOf(null), 200);
    assert.equal(logLimitOf("50"), 50);
    assert.equal(logLimitOf("9999"), 500);
    assert.equal(logLimitOf("nope", 20), 20);
  });

  await test("active boosts: only the ones in force", async () => {
    const rows = [
      { id: R, crm_restaurant_id: "crm-1", name: "Firecracker's", ...row },
      { id: "rest-2", crm_restaurant_id: null, name: "Other", busy_boost_minutes: 10, busy_until: new Date(NOW - 1000).toISOString() },
      { id: "rest-3", crm_restaurant_id: null, name: "None", busy_boost_minutes: null, busy_until: null },
    ];
    const live = await readActiveBusy(fakeAdmin({ restaurants: rows.filter((r) => r.busy_until) }), NOW);
    assert.deepEqual(live.map((b) => [b.restaurant.crm_restaurant_id, b.minutes]), [["crm-1", 15]]);
  });

  await test("the feed carries it only when asked, and a failed read never fails the feed", () => {
    const route = src("app/api/crm/orders/route.ts");
    assert.match(route, /q\.get\("cook_after"\)/);
    assert.match(route, /\.\.\.\(cookTime \? \{ cook_time: cookTime \} : \{\}\)/);
    assert.match(route, /cookTime = \{ error:/);
  });

  console.log("ending it");

  const rest = () => ({ id: R, prep_minutes: 25, ...row, busy_until: new Date(Date.now() + 3_600_000).toISOString() });

  await test("ending writes one row, and ending again changes nothing", async () => {
    const r = rest();
    const admin = fakeAdmin({ restaurants: [{ ...r }] });
    const first = await endBusy(admin, r, { source: "crm", actor: "dana" });
    assert.equal(first.changed, true);
    const log = admin.writes.filter((w) => w.table === "cook_time_log");
    assert.equal(log.length, 1);
    assert.equal((log[0]!.value as any).kind, "boost_end");
    assert.equal((log[0]!.value as any).source, "crm");
    // The boost this call read is gone: same read again matches no row.
    const stale = await endBusy(fakeAdmin({ restaurants: [{ id: R, busy_until: null }] }), r, { source: "tablet", actor: "x" });
    assert.equal(stale.changed, false);
    const none = await endBusy(fakeAdmin({ restaurants: [] }), { id: R, prep_minutes: 25 }, { source: "tablet", actor: "x" });
    assert.equal(none.changed, false);
  });

  console.log("routes and screen");

  await test("the tablet's routes take the restaurant from the session and run the limits", () => {
    for (const p of ["app/api/dashboard/store/busy/route.ts", "app/api/dashboard/store/cook-time/route.ts"]) {
      const s = src(p);
      assert.match(s, /await storeSession\(\)/);
      assert.match(s, /s\.restaurantId/);
      assert.match(s, /cookLimitsOf\(r\)/);
      assert.doesNotMatch(s, /body\.restaurant|restaurant_id\s*[:=]\s*body/);
    }
    const busy = src("app/api/dashboard/store/busy/route.ts");
    assert.match(busy, /code: "busy_already_on"/);
    assert.match(busy, /\.is\("busy_until", null\)/, "two presses at once start one boost");
  });

  await test("restaurant sessions cannot write the columns directly", () => {
    assert.match(src("db/schema.sql"), /create policy "restaurants_admin_write" on restaurants for all\s+using \(is_admin\(\)\)/);
    const later = readFileSyncAll();
    assert.doesNotMatch(later, /policy[^;]*on restaurants\s+for update/i);
  });

  await test("the CRM routes need the key and take either id", () => {
    for (const p of ["app/api/crm/cook-time/changes/route.ts", "app/api/crm/restaurants/[id]/cook-time/route.ts"]) {
      const s = src(p);
      assert.match(s, /authorizeCrmWrite\(req\)/);
      assert.match(s, /findRestaurantByRef/);
    }
    assert.match(src("lib/crm-roster.ts"), /cook_limits: cookLimitsOf\(r\)/);
  });

  await test("the screen: Busy on the Store tab, a banner with End now over the orders, Accept pre-selected", () => {
    const tab = src("components/StoreTab.tsx");
    assert.match(tab, /<h3 className="store-h">Busy<\/h3>/);
    assert.match(tab, /\/api\/dashboard\/store\/busy/);
    const dash = src("components/OrderDashboard.tsx");
    assert.match(dash, /busyLine\(activeBusy/);
    assert.match(dash, /End now/);
    assert.match(dash, /acceptMinutes=\{preselected\}/);
    assert.equal(busyLine({ minutes: 15, until: "2026-11-07T01:30:00.000Z" }, "America/Chicago"), "Busy: +15 min until 7:30 PM");
    assert.deepEqual([30, 60, 120, 90].map(lengthLabel), ["30 min", "1 hour", "2 hours", "90 min"]);
  });

  console.log(`\n${passed} passed`);
}

/** Every migration, to check no later one opened restaurants up to its own members. */
function readFileSyncAll(): string {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync("db/migrations").map((f) => readFileSync(`db/migrations/${f}`, "utf8")).join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
