/**
 * The menu on the tablet and the edits made there (migration 049).
 *
 * Worth asserting: a CRM push is checked whole (a ref missing anywhere fails
 * it); an edit names its item by ref and becomes exactly the line the CRM's
 * rules parser reads; an edit that changes nothing is refused; "Sent to
 * Premium" is decided by the push time; and, by reading the routes, that the
 * tablet never writes the menu and the CRM never writes without the key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOLD_OUT_CHOICES, filterMenu, findMenuItem, isoWithOffset, parseMenuEdits as parseEdits, parseMenuPush, parsePriceInput, pendingRefs, restOfTodayUntil, untilLabel, type TabletMenu } from "@/lib/menu-editor";
import { emptyWeek } from "@/lib/store";

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

const push = {
  menu_id: "snap-1",
  source: "zuppler",
  categories: [
    { ref: "c1", name: "Plates", items: [
      { ref: "i1", name: "Rib Plate", price_cents: 2299, available: true, description: "Half slab" },
      { ref: "i2", name: "Brisket Plate", price_cents: 1899, available: false },
    ] },
    { ref: "c2", name: "Desserts", items: [{ ref: "i3", name: "Banana Pudding", price_cents: 499 }] },
  ],
};
const parsed = parseMenuPush(push);
assert.ok(parsed.ok);
const menu: TabletMenu = parsed.ok ? parsed.menu : (null as never);

const ZONE = "America/Chicago";
/** Open 11-9 every day but Sunday. */
const WEEK = { ...emptyWeek(), monday: [{ open: "11:00", close: "21:00" }], tuesday: [{ open: "11:00", close: "21:00" }], wednesday: [{ open: "11:00", close: "21:00" }], thursday: [{ open: "11:00", close: "21:00" }], friday: [{ open: "11:00", close: "21:00" }], saturday: [{ open: "11:00", close: "21:00" }] };
/** Friday 2 PM in Chicago; the next day is open. */
const FRI_2PM = new Date("2026-11-06T20:00:00Z");
/** Saturday 2 PM in Chicago; Sunday is closed. */
const SAT_2PM = new Date("2026-11-07T20:00:00Z");
const ctx = { now: FRI_2PM, zone: ZONE, hours: WEEK as unknown };
const parseMenuEdits = (input: unknown, m: TabletMenu) => parseEdits(input, m, ctx);
const local = (at: Date | null) => (at ? isoWithOffset(at, ZONE) : null);

test("a push is accepted whole and counted", () => {
  assert.equal(parsed.ok && parsed.itemCount, 3);
  assert.equal(findMenuItem(menu, "i3")?.item.available, true, "available defaults to true");
  assert.equal(findMenuItem(menu, "i2")?.category.name, "Plates");
});

test("a push with a hole in it is refused, naming the hole", () => {
  const bad = structuredClone(push) as any;
  delete bad.categories[1].items[0].ref;
  const r = parseMenuPush(bad);
  assert.ok("error" in r && /Desserts item 0: bad ref/.test(r.error));
  const dup = structuredClone(push) as any;
  dup.categories[1].items[0].ref = "i1";
  assert.ok(!parseMenuPush(dup).ok);
  assert.ok(!parseMenuPush({ source: "zuppler", categories: [] }).ok, "menu_id is required");
  assert.ok(!parseMenuPush({ menu_id: "x", categories: [{ ref: "c", name: "C", items: [{ ref: "i", name: "I", price_cents: 12.5 }] }] }).ok, "cents are whole");
});

test("each edit becomes the CRM parser's exact line, by ref", () => {
  const r = parseMenuEdits(
    [
      { ref: "i1", action: "set_price", price_cents: 2499 },
      { ref: "i1", action: "sold_out" },
      { ref: "i2", action: "back_on" },
      { ref: "i3", action: "rename", name: "Nana's Banana Pudding -> yes" },
    ],
    menu
  );
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.menuChanges.lines, ["price #i1 = 24.99", "86 #i1", "un-86 #i2", "rename #i3 -> Nana's Banana Pudding - yes"]);
  assert.equal(r.ok && r.menuChanges.menu_id, "snap-1");
  assert.equal(r.ok && r.body, 'Rib Plate: $22.99 to $24.99\nRib Plate: sold out until 11:00 AM tomorrow\nBrisket Plate: back on the menu\nBanana Pudding: renamed to "Nana\'s Banana Pudding - yes"');
});

test("an edit that changes nothing, or names an item not on the menu, is refused", () => {
  assert.match((parseMenuEdits({ ref: "i1", action: "set_price", price_cents: 2299 }, menu) as any).error, /already \$22\.99/);
  assert.match((parseMenuEdits({ ref: "i2", action: "sold_out" }, menu) as any).error, /already marked sold out/);
  assert.match((parseMenuEdits({ ref: "i1", action: "back_on" }, menu) as any).error, /already on the menu/);
  assert.match((parseMenuEdits({ ref: "nope", action: "sold_out" }, menu) as any).error, /isn't on the menu any more/);
  assert.match((parseMenuEdits({ ref: "i1", action: "set_price", price_cents: 0 }, menu) as any).error, /between/);
  assert.match((parseMenuEdits({ ref: "i1", action: "rename", name: "  " }, menu) as any).error, /new name/);
  assert.ok(!parseMenuEdits([], menu).ok);
  assert.ok(!parseMenuEdits({ ref: "i1", action: "delete" }, menu).ok, "the tablet cannot delete");
});

test("the three choices are offered in the same order everywhere, Rest of today first", () => {
  assert.deepEqual(SOLD_OUT_CHOICES.map((c) => [c.key, c.label]), [["rest_of_today", "Rest of today"], ["back_at", "Back at…"], ["until_turned_back_on", "Until we turn it back on"]]);
});

test("Rest of today ends at the next day's opening", () => {
  assert.equal(local(restOfTodayUntil(WEEK, FRI_2PM, ZONE)), "2026-11-07T11:00:00-06:00");
});

test("Rest of today skips a closed day", () => {
  assert.equal(local(restOfTodayUntil(WEEK, SAT_2PM, ZONE)), "2026-11-09T11:00:00-06:00");
});

test("Rest of today falls back to 4:00 AM local when the hours are missing, malformed or all closed", () => {
  for (const hours of [null, undefined, "nope", {}, emptyWeek(), { ...emptyWeek(), monday: [{ open: "bad", close: "21:00" }] }]) {
    assert.equal(local(restOfTodayUntil(hours, SAT_2PM, ZONE)), "2026-11-08T04:00:00-06:00");
  }
  assert.equal(local(restOfTodayUntil(null, new Date("2026-11-07T08:00:00Z"), ZONE)), "2026-11-07T04:00:00-06:00", "2 AM: 4 AM is still today");
});

test("Rest of today does not end at this morning's opening or at today's dinner", () => {
  const split = { ...WEEK, friday: [{ open: "11:00", close: "14:00" }, { open: "17:00", close: "21:00" }] };
  assert.equal(local(restOfTodayUntil(split, new Date("2026-11-06T18:00:00Z"), ZONE)), "2026-11-07T11:00:00-06:00", "noon, between lunch and dinner");
  assert.equal(local(restOfTodayUntil(WEEK, new Date("2026-11-06T15:00:00Z"), ZONE)), "2026-11-07T11:00:00-06:00", "9 AM, before opening");
});

test("Rest of today treats the hours before 4 AM as last night", () => {
  const bar = { ...emptyWeek(), friday: [{ open: "16:00", close: "02:00" }], saturday: [{ open: "16:00", close: "02:00" }] };
  assert.equal(local(restOfTodayUntil(bar, new Date("2026-11-07T07:00:00Z"), ZONE)), "2026-11-07T16:00:00-06:00", "1 AM Saturday, still Friday's shift");
  assert.equal(local(restOfTodayUntil(bar, new Date("2026-11-07T05:00:00Z"), ZONE)), "2026-11-07T16:00:00-06:00", "11 PM Friday");
  const allDay = { ...emptyWeek(), friday: [{ open: "00:00", close: "23:59" }], saturday: [{ open: "00:00", close: "23:59" }] };
  assert.equal(local(restOfTodayUntil(allDay, FRI_2PM, ZONE)), "2026-11-07T00:00:00-06:00", "open all day comes back at midnight");
});

test("until carries the restaurant's own offset across a clock change", () => {
  assert.equal(local(restOfTodayUntil({ ...emptyWeek(), sunday: [{ open: "11:00", close: "21:00" }] }, new Date("2027-03-13T20:00:00Z"), ZONE)), "2027-03-14T11:00:00-05:00");
  assert.equal(isoWithOffset(new Date("2026-11-07T17:00:00Z"), "Asia/Kolkata"), "2026-11-07T22:30:00+05:30");
});

const soldOut = (extra: Record<string, unknown>) => parseEdits({ ref: "i1", action: "sold_out", ...extra }, menu, ctx);
const firstChange = (r: ReturnType<typeof soldOut>) => (r.ok ? r.menuChanges.changes[0]! : assert.fail("error" in r ? r.error : "refused"));

test("each choice puts until on its change and leaves the parser line alone", () => {
  const today = firstChange(soldOut({ sold_out_for: "rest_of_today" }));
  assert.equal(today.until, "2026-11-07T11:00:00-06:00");
  assert.equal(today.line, "86 #i1");
  assert.equal(today.text, "Rib Plate: sold out until 11:00 AM tomorrow");

  const back = firstChange(soldOut({ sold_out_for: "back_at", back_day: "today", back_time: "17:30" }));
  assert.equal(back.until, "2026-11-06T17:30:00-06:00");
  assert.equal(back.line, "86 #i1");
  assert.equal(back.text, "Rib Plate: sold out until 5:30 PM today");

  const tomorrow = firstChange(soldOut({ sold_out_for: "back_at", back_day: "tomorrow", back_time: "09:00" }));
  assert.equal(tomorrow.until, "2026-11-07T09:00:00-06:00");

  const open = firstChange(soldOut({ sold_out_for: "until_turned_back_on" }));
  assert.equal(open.until, null);
  assert.equal(open.line, "86 #i1");
  assert.equal(open.text, "Rib Plate: sold out until turned back on");
});

test("an old tablet that sends no choice is treated as Rest of today", () => {
  assert.deepEqual(firstChange(soldOut({})), firstChange(soldOut({ sold_out_for: "rest_of_today" })));
  assert.deepEqual(firstChange(soldOut({ sold_out_for: null })), firstChange(soldOut({ sold_out_for: "rest_of_today" })));
});

test("Back at must be a real time later than now", () => {
  assert.match((soldOut({ sold_out_for: "back_at", back_day: "today", back_time: "13:59" }) as any).error, /later than now/);
  assert.match((soldOut({ sold_out_for: "back_at", back_day: "today", back_time: "14:00" }) as any).error, /later than now/);
  assert.match((soldOut({ sold_out_for: "back_at", back_day: "today" }) as any).error, /Pick a time/);
  assert.match((soldOut({ sold_out_for: "back_at", back_day: "today", back_time: "25:00" }) as any).error, /Pick a time/);
  assert.match((soldOut({ sold_out_for: "back_at", back_day: "next week", back_time: "12:00" }) as any).error, /today or tomorrow/);
  assert.match((soldOut({ sold_out_for: "forever" }) as any).error, /how long/);
});

test("only a sold-out change carries until", () => {
  const r = parseMenuEdits([{ ref: "i1", action: "set_price", price_cents: 2499 }, { ref: "i2", action: "back_on" }, { ref: "i3", action: "rename", name: "Pudding" }], menu);
  assert.ok(r.ok);
  for (const c of r.ok ? r.menuChanges.changes : []) assert.ok(!("until" in c), `${c.action} carries until`);
});

test("until reads as today, tomorrow or the weekday", () => {
  assert.equal(untilLabel("2026-11-06T17:30:00-06:00", FRI_2PM, ZONE), "5:30 PM today");
  assert.equal(untilLabel("2026-11-07T11:00:00-06:00", FRI_2PM, ZONE), "11:00 AM tomorrow");
  assert.equal(untilLabel("2026-11-09T11:00:00-06:00", SAT_2PM, ZONE), "11:00 AM Monday");
});

test("the contract's sample is what the code sends", () => {
  const contract = src("docs/crm-bridge-contract.md");
  const block = contract.match(/```json\s*(\{\s*"menu_id": "<the CRM menu snapshot id[\s\S]*?\})\s*```/);
  assert.ok(block, "the Menu tab sample is in the contract");
  const sample = JSON.parse(block![1]!);
  const contractMenu: TabletMenu = { menu_id: sample.menu_id, source: "zuppler", categories: [{ ref: "c", name: "Plates", items: [
    { ref: "1234", name: "Rib Plate", price_cents: 2299, available: true, description: null },
    { ref: "1235", name: "Banana Pudding", price_cents: 499, available: true, description: null },
    { ref: "1236", name: "Soup of the Day", price_cents: 599, available: true, description: null },
  ] }] };
  const r = parseEdits(
    [
      { ref: "1234", action: "set_price", price_cents: 2499 },
      { ref: "1235", action: "sold_out", sold_out_for: "rest_of_today" },
      { ref: "1236", action: "sold_out", sold_out_for: "until_turned_back_on" },
    ],
    contractMenu,
    ctx
  );
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.menuChanges, sample);
  assert.match(contract, /no `until` key[^.]*Rest of today/i);
});

test("the sold-out prompt is on the Menu tab, and the server works out until from the restaurant's hours", () => {
  const editor = src("components/MenuEditor.tsx");
  assert.match(editor, /How long is it sold out\?/);
  assert.match(editor, /SOLD_OUT_CHOICES\.map/);
  assert.match(editor, /useState<SoldOutFor>\("rest_of_today"\)/);
  assert.doesNotMatch(editor, /action: "sold_out" \}\)/, "the button must ask first");
  assert.match(editor, /type="time"/);
  const route = src("app/api/dashboard/menu/changes/route.ts");
  assert.match(route, /from\("restaurant_profiles"\)\.select\("hours"\)/);
  assert.match(route, /from\("restaurants"\)\.select\("timezone"\)/);
  assert.match(route, /parseMenuEdits\(input\.edits, menu, \{ now: new Date\(\), zone: [^,]+, hours: [^}]+\}\)/);
  assert.match(src("app/api/dashboard/menu/route.ts"), /rest_of_today_until/);
});

test("a typed price is read the way a kitchen writes it", () => {
  assert.equal(parsePriceInput("24.99"), 2499);
  assert.equal(parsePriceInput("$24.99"), 2499);
  assert.equal(parsePriceInput("24"), 2400);
  assert.equal(parsePriceInput("24.5"), 2450);
  assert.equal(parsePriceInput("0"), null);
  assert.equal(parsePriceInput("abc"), null);
  assert.equal(parsePriceInput("1000"), null);
});

test("Sent to Premium is decided by the push time", () => {
  const changes = { menu_id: "snap-1", lines: ["86 #i1"], changes: [{ ref: "i1", action: "sold_out" as const, item: "Rib Plate", line: "86 #i1", text: "" }] };
  const before = { created_at: "2026-10-06T10:00:00Z", menu_changes: changes };
  const after = { created_at: "2026-10-06T12:00:00Z", menu_changes: changes };
  const typed = { created_at: "2026-10-06T12:30:00Z", menu_changes: null };
  assert.deepEqual([...pendingRefs([before, after, typed], "2026-10-06T11:00:00Z")], ["i1"]);
  assert.deepEqual([...pendingRefs([before], "2026-10-06T11:00:00Z")], []);
});

test("search keeps category order and drops empty categories", () => {
  assert.deepEqual(filterMenu(menu, "plate").map((c) => [c.name, c.items.length]), [["Plates", 2]]);
  assert.deepEqual(filterMenu(menu, "").length, 2);
  assert.deepEqual(filterMenu(menu, "zzz"), []);
});

test("the CRM push needs the key; the tablet routes take the restaurant from the session and never write the menu", () => {
  const crm = src("app/api/crm/restaurants/[id]/menu/route.ts");
  assert.match(crm, /authorizeCrmWrite\(req\)/);
  assert.match(crm, /findRestaurantByRef/);
  for (const p of ["app/api/dashboard/menu/route.ts", "app/api/dashboard/menu/changes/route.ts"]) {
    const s = src(p);
    assert.match(s, /getCurrentUserRestaurantIds/);
    assert.doesNotMatch(s, /restaurant_id:\s*(input|body)\./, `${p} takes the restaurant from the body`);
  }
  const changes = src("app/api/dashboard/menu/changes/route.ts");
  // Every statement on restaurant_menus in the tablet routes is a read.
  for (const p of ["app/api/dashboard/menu/route.ts", "app/api/dashboard/menu/changes/route.ts"]) {
    for (const m of src(p).matchAll(/from\("restaurant_menus"\)([^;]*);/g)) {
      assert.doesNotMatch(m[1]!, /\.(upsert|update|insert|delete)\(/, `${p} writes the menu`);
    }
  }
  assert.match(changes, /kind: "menu_change"/);
  const sql = src("db/migrations/049_restaurant_menus.sql");
  assert.match(sql, /enable row level security/);
  assert.match(sql, /menu_changes jsonb/);
});

test("the dashboard has a Menu tab and the chat's Update menu opens it", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /tab === "menu" && <MenuEditor/);
  assert.match(dash, /onOpenMenu=\{\(\) => setTab\("menu"\)\}/);
  assert.match(src("components/DispatchMessages.tsx"), /onOpenMenu\(\)/);
});

console.log(`\n${passed} passed`);
