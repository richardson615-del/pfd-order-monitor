/**
 * The Store tab: pause online orders and change hours (migration 052).
 *
 * Worth asserting: a pause lasts exactly what was picked and "rest of
 * today" ends at 4 AM restaurant time (across DST too); an expired pause
 * reads as none; an hours week is checked whole (every day, two ranges at
 * most, no overlap, past-midnight allowed); the message words name only
 * the days that change; and, by reading the routes, that the tablet's
 * restaurant comes from the session, the CRM writes the profile only with
 * its key, the profile push never touches the pause, and the generic
 * message route cannot send a pause.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dayLine, emptyWeek, endOfServiceDay, hoursMessageBody, livePause, parseHoursChange, parsePause, parseProfilePush, pauseMessageBody, readWeek, time12, type WeeklyHours } from "@/lib/store";
import { MESSAGE_KINDS, messageKindLabel, parseTabletMessage } from "@/lib/messages";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    throw err;
  }
}
const src = (p: string) => readFileSync(p, "utf8");
const TZ = "America/Chicago";

console.log("pause");

test("a timed pause lasts exactly the choice", () => {
  const now = new Date("2026-10-24T22:00:00Z"); // 5:00 PM CDT
  const d = parsePause({ choice: "30", reason: "  slammed\n  " }, now, TZ);
  assert.equal(d.kind, "pause");
  if (d.kind !== "pause") return;
  assert.equal(d.until.toISOString(), "2026-10-24T22:30:00.000Z");
  assert.equal(d.reason, "slammed");
  assert.match(pauseMessageBody(d, TZ), /^Paused online orders for 30 minutes \(until 5:30 PM\)\. Reason: slammed/);
});

test("rest of today ends at 4 AM restaurant time, also before 4 AM and across the DST change", () => {
  assert.equal(endOfServiceDay(new Date("2026-10-24T22:00:00Z"), TZ).toISOString(), "2026-10-25T09:00:00.000Z"); // 4 AM CDT
  assert.equal(endOfServiceDay(new Date("2026-10-25T07:30:00Z"), TZ).toISOString(), "2026-10-25T09:00:00.000Z"); // 2:30 AM CDT -> today 4 AM
  // DST ends 2026-11-01 at 2 AM: 4 AM that morning is CST (UTC-6).
  assert.equal(endOfServiceDay(new Date("2026-10-31T23:00:00Z"), TZ).toISOString(), "2026-11-01T10:00:00.000Z");
});

test("resume, a bad choice, and an expired pause", () => {
  assert.deepEqual(parsePause({ resume: true }, new Date(), TZ), { kind: "resume" });
  assert.equal(parsePause({ choice: "45" }, new Date(), TZ).kind, "error");
  const now = new Date("2026-10-24T22:00:00Z");
  assert.equal(livePause({ online_paused_until: "2026-10-24T21:59:00Z", online_pause_reason: null, online_paused_at: null }, now), null);
  assert.equal(livePause({ online_paused_until: "2026-10-24T22:10:00Z", online_pause_reason: "x", online_paused_at: null }, now)?.reason, "x");
  assert.equal(pauseMessageBody({ kind: "resume" }, TZ), "Turned online orders back on.");
});

console.log("hours");

const week = (): WeeklyHours => ({
  sunday: [],
  monday: [{ open: "11:00", close: "21:00" }],
  tuesday: [{ open: "11:00", close: "21:00" }],
  wednesday: [{ open: "11:00", close: "21:00" }],
  thursday: [{ open: "11:00", close: "14:00" }, { open: "17:00", close: "22:00" }],
  friday: [{ open: "16:00", close: "02:00" }],
  saturday: [{ open: "11:00", close: "22:00" }],
});

test("a good week parses, past midnight allowed, split ranges sorted", () => {
  const w = week();
  w.thursday = [{ open: "17:00", close: "22:00" }, { open: "11:00", close: "14:00" }];
  const d = parseHoursChange({ hours: w, note: "winter hours" });
  assert.equal(d.kind, "ok");
  if (d.kind !== "ok") return;
  assert.deepEqual(d.hours.thursday, [{ open: "11:00", close: "14:00" }, { open: "17:00", close: "22:00" }]);
  assert.equal(d.note, "winter hours");
});

test("missing days, three ranges, overlaps, bad times and an all-closed week are refused", () => {
  const { sunday: _s, ...noSunday } = week();
  assert.equal(parseHoursChange({ hours: noSunday }).kind, "error");
  const w = week();
  w.monday = [{ open: "08:00", close: "10:00" }, { open: "11:00", close: "12:00" }, { open: "13:00", close: "14:00" }];
  assert.equal(parseHoursChange({ hours: w }).kind, "error");
  const o = week();
  o.monday = [{ open: "11:00", close: "15:00" }, { open: "14:00", close: "20:00" }];
  assert.equal(parseHoursChange({ hours: o }).kind, "error");
  const b = week();
  b.monday = [{ open: "11am", close: "21:00" }];
  assert.equal(parseHoursChange({ hours: b }).kind, "error");
  assert.equal(parseHoursChange({ hours: emptyWeek() }).kind, "error");
});

test("the message names only the days that change", () => {
  const current = week();
  const next = week();
  next.sunday = [{ open: "12:00", close: "18:00" }];
  const body = hoursMessageBody(next, current, null);
  assert.equal(body, "New hours from the restaurant - Sunday: 12:00 PM - 6:00 PM.");
  assert.match(hoursMessageBody(next, null, "x"), /Monday: 11:00 AM - 9:00 PM.*Note: x$/);
  assert.equal(dayLine("friday", week().friday), "Friday: 4:00 PM - 2:00 AM");
  assert.equal(time12("00:15"), "12:15 AM");
});

test("the CRM's profile push: shape checked, 24:00 read as 23:59, an all-closed week allowed", () => {
  const ok = parseProfilePush({ hours: { ...emptyWeek(), monday: [{ open: "00:00", close: "24:00" }] }, hours_lines: ["Monday: Open 24 hours"], ordering_channel: "both" });
  assert.equal(ok.kind, "ok");
  if (ok.kind !== "ok") return;
  assert.deepEqual(ok.hours?.monday, [{ open: "00:00", close: "23:59" }]);
  assert.equal(ok.ordering_channel, "both");
  assert.equal(parseProfilePush({ hours: { monday: "9-5" } }).kind, "error");
  const none = parseProfilePush({ hours: null });
  assert.ok(none.kind === "ok" && none.hours === null);
  assert.equal(readWeek({ nope: 1 }), null);
});

console.log("messages and routes");

test("the generic message route cannot send a pause or an hours change", () => {
  assert.ok(!MESSAGE_KINDS.includes("pause" as never));
  assert.ok("error" in parseTabletMessage({ kind: "pause", body: "x" }));
  assert.equal(messageKindLabel("pause"), "Online orders");
  assert.equal(messageKindLabel("hours_change"), "Hours change");
  assert.equal(messageKindLabel("text"), null);
});

test("routes: the session picks the restaurant, the CRM writes the profile with its key, and never the pause", () => {
  for (const p of ["app/api/dashboard/store/route.ts", "app/api/dashboard/store/pause/route.ts", "app/api/dashboard/store/hours/route.ts"]) {
    const s = src(p);
    assert.match(s, /storeSession\(\)/, p);
    assert.doesNotMatch(s, /restaurant_id: (body|input|o)\./, p);
  }
  const profile = src("app/api/crm/restaurants/[id]/profile/route.ts");
  assert.match(profile, /authorizeCrmWrite\(req\)/);
  assert.doesNotMatch(profile.split("export async function GET")[0]!, /online_paused/);
  const hours = src("app/api/dashboard/store/hours/route.ts");
  assert.doesNotMatch(hours, /from\("restaurant_profiles"\)\s*\.(upsert|update|insert)/);
  const m = src("db/migrations/052_store_hours_and_pause.sql");
  assert.match(m, /'pause', 'hours_change'/);
  assert.match(m, /restaurant_profiles enable row level security/);
  assert.match(src("components/DispatchMessages.tsx"), /messageKindLabel\(m\.kind\)/);
});

console.log(`\n${passed} passed`);
