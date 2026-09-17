/**
 * How an order reads on the tablet.
 *
 * Two lists and one action since 2026-09-16 (Workstream I2). The assertions
 * worth having are not about pixels: that the two lists are decided by one
 * rule in the restaurant's own day, that the list empties at midnight and
 * not after six hours, that age only shouts about orders somebody still has
 * to act on, that the NEW pill means exactly "nobody has opened this", and
 * that the two display modes never disagree about what is TRUE.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGE_LATE_MS,
  AGE_WARN_MS,
  ageClass,
  bucketOf,
  completedToday,
  displayMode,
  elapsedLabel,
  inKitchen,
  isLate,
  isSettled,
  isUnopened,
  itemsLine,
  orderFlag,
} from "@/lib/order-display";
import { STILL_ACTIONABLE_MS, unaccepted } from "@/lib/kiosk";
import { dayLabel, isSameLocalDay, localDayKey, recentDayKeys, timeLabel } from "@/lib/local-day";
import { HISTORY_DAY_CAP, countsForHistory, historyWindowStart, money, weekHistory } from "@/lib/history";

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

// 2 pm Central on a Wednesday. UTC is 19:00 the same day.
const TZ = "America/Chicago";
const NOW = Date.parse("2026-09-16T19:00:00Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();
const order = (over: Record<string, any> = {}) =>
  ({
    id: "o1",
    status: "new",
    opened_at: null,
    accepted_at: null,
    completed_at: null,
    cancelled_at: null,
    received_at: agoMs(60_000),
    ...over,
  }) as any;

console.log("the restaurant's own day:");

test("a day key is the restaurant's date, not UTC's", () => {
  // 23:30 Central on the 16th is 04:30 UTC on the 17th.
  assert.equal(localDayKey("2026-09-17T04:30:00Z", TZ), "2026-09-16");
  assert.equal(localDayKey("2026-09-17T04:30:00Z", "UTC"), "2026-09-17");
  assert.equal(localDayKey("garbage", TZ), "");
});

test("same-day is decided in the zone", () => {
  assert.equal(isSameLocalDay("2026-09-17T04:30:00Z", NOW, TZ), true, "late tonight Central is still today");
  assert.equal(isSameLocalDay("2026-09-16T04:30:00Z", NOW, TZ), false, "late last night Central is not");
  assert.equal(isSameLocalDay(null, NOW, TZ), false);
});

test("an unknown zone falls back to the device's, and never throws", () => {
  assert.equal(localDayKey(NOW, null).length, 10);
  assert.equal(localDayKey(NOW, "Not/AZone").length, 10);
});

test("the last seven days end today and have no duplicates", () => {
  const keys = recentDayKeys(NOW, TZ, 7);
  assert.equal(keys.length, 7);
  assert.equal(keys[6], "2026-09-16");
  assert.equal(keys[0], "2026-09-10");
  assert.equal(new Set(keys).size, 7);
});

test("day labels: Today, Yesterday, then the weekday", () => {
  assert.equal(dayLabel("2026-09-16", NOW, TZ), "Today");
  assert.equal(dayLabel("2026-09-15", NOW, TZ), "Yesterday");
  assert.equal(dayLabel("2026-09-14", NOW, TZ), "Mon");
  assert.equal(dayLabel("2026-09-10", NOW, TZ), "Thu");
});

test("times are shown in the zone", () => {
  assert.match(timeLabel("2026-09-16T19:00:00Z", TZ), /2:00\s?PM/);
  assert.match(timeLabel("2026-09-16T19:00:00Z", "UTC"), /7:00\s?PM/);
  assert.equal(timeLabel(null, TZ), "");
});

console.log("\ntwo lists, one rule:");

test("an order in the kitchen is one received today and not settled", () => {
  assert.equal(bucketOf(order(), NOW, TZ), "orders");
  assert.equal(bucketOf(order({ status: "opened", opened_at: agoMs(30_000) }), NOW, TZ), "orders", "opened is still cooking");
  assert.equal(bucketOf(order({ status: "printed" }), NOW, TZ), "orders", "paper does not settle it");
  assert.equal(inKitchen(order(), NOW, TZ), true);
});

test("it leaves the kitchen six hours after it arrived - the chime's window", () => {
  // The brief's bold default. Past six hours the tablet has stopped
  // ringing for it and nobody is going to cook it.
  assert.equal(bucketOf(order({ received_at: agoMs(STILL_ACTIONABLE_MS - 1000) }), NOW, TZ), "orders");
  assert.equal(bucketOf(order({ received_at: agoMs(STILL_ACTIONABLE_MS) }), NOW, TZ), "past");
  assert.equal(bucketOf(order({ received_at: agoMs(7 * 3600_000) }), NOW, TZ), "past", "seven hours old: gone, whatever the day");
  // Independent of the zone - it is an age, not a date.
  assert.equal(bucketOf(order({ received_at: agoMs(5 * 3600_000) }), NOW, "UTC"), "orders");
  assert.equal(bucketOf(order({ received_at: agoMs(5 * 3600_000) }), NOW, TZ), "orders");
});

test("ageing out does not fabricate a completion", () => {
  // It simply stops being in the kitchen; its status is whatever it was.
  const old = order({ received_at: agoMs(7 * 3600_000) });
  assert.equal(bucketOf(old, NOW, TZ), "past");
  assert.equal(old.status, "new");
  assert.equal(completedToday(old, NOW, TZ), false);
  assert.equal(countsForHistory(old), true, "and Past week still counts it as business done");
});

test("completed today is by when it was completed, not received", () => {
  const doneToday = order({ status: "completed", received_at: "2026-09-16T04:00:00Z", completed_at: agoMs(60_000) });
  assert.equal(bucketOf(doneToday, NOW, TZ), "completed", "received last night, finished today: today's");
  const doneYesterday = order({ status: "completed", received_at: agoMs(10 * 3600_000), completed_at: "2026-09-16T04:00:00Z" });
  assert.equal(bucketOf(doneYesterday, NOW, TZ), "past");
  const noStamp = order({ status: "completed", completed_at: null });
  assert.equal(bucketOf(noStamp, NOW, TZ), "completed", "no completed_at: fall back to received");
});

test("a cancellation today is shown under Completed, struck - it does not vanish", () => {
  assert.equal(bucketOf(order({ status: "cancelled", cancelled_at: agoMs(1000) }), NOW, TZ), "completed");
  assert.equal(orderFlag(order({ status: "cancelled" }))?.label, "Cancelled");
  assert.match(src("app/globals.css"), /\.done-row\.cancelled \.done-name,\r?\n\.done-row\.cancelled \.done-no \{ text-decoration: line-through/);
});

test("the dashboard's lists and counts all come from bucketOf", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /bucketOf\(o, now, timezone\) === "orders"/);
  assert.match(dash, /bucketOf\(o, now, timezone\) === "completed"/);
  assert.doesNotMatch(dash, /isWaiting|inTab\(|"Show all"|key === "accepted"/);
  // Orders: unaccepted oldest-first, then accepted by least time left
  // (lib/countdown.ts kitchenSort, I3); the hero reads the same list.
  assert.match(dash, /kitchenSort\(orders\.filter\(\(o\) => bucketOf\(o, now, timezone\) === "orders"\), prepMinutes, now\)/);
  assert.match(dash, /const hero = useMemo\(\(\) => heroSummary\(kitchen, prepMinutes, now, AGE_LATE_MS\)/);
  // The tabs are the three Nick named.
  for (const t of ["Orders", "Completed", "Past week"]) assert.ok(dash.includes(`\n          ${t}`) || dash.includes(`>${t}`) || dash.includes(` ${t} `), `tab ${t}`);
});

console.log("\nthe NEW pill and the chime agree:");

test("NEW means nobody has accepted it; opening does NOT clear it (I3); Accept does", () => {
  assert.equal(isUnopened(order()), true);
  assert.equal(orderFlag(order())?.label, "New");
  assert.equal(isUnopened(order({ opened_at: agoMs(1000) })), true, "a look is not 'we've got it'");
  assert.equal(orderFlag(order({ status: "opened", opened_at: agoMs(1000) }))?.label, "New");
  assert.equal(isUnopened(order({ accepted_at: agoMs(1000) })), false);
  assert.equal(orderFlag(order({ status: "opened", accepted_at: agoMs(1000) })), null, "nothing to say from here while it is being cooked - the countdown speaks");
});

test("the pill and the chime cannot drift", () => {
  for (const o of [
    order(),
    order({ status: "opened" }),
    order({ status: "printed" }),
    order({ opened_at: agoMs(1000) }),
    order({ accepted_at: agoMs(1000) }),
    order({ status: "completed" }),
    order({ status: "cancelled" }),
  ]) {
    assert.equal(orderFlag(o)?.tone === "new", unaccepted([o], NOW).length === 1, JSON.stringify(o));
  }
});

test("there is no Printed flag; Accept and Complete are the two actions (I3)", () => {
  assert.equal(orderFlag(order({ status: "printed" }))?.label, "New", "paper is not a state the tablet reports");
  assert.doesNotMatch(src("lib/order-display.ts"), /label: "(Accepted|Printed|Waiting)"/);
  const viewer = src("components/OrderViewer.tsx");
  assert.match(viewer, /accepted: true/, "Accept is a tap on the ticket");
  assert.match(viewer, /status: "completed"/, "Complete ends it");
  assert.match(viewer, /window\.location\.assign\("\/dashboard"\)/, "and returns to Orders");
  assert.doesNotMatch(viewer, />\s*Done\s*</, "the button is Complete now");
});

console.log("\nan order only shouts while somebody has to act on it:");

test("a fresh order is calm", () =>
  assert.equal(ageClass(order(), NOW), "age-calm"));

test("five minutes goes amber", () =>
  assert.equal(ageClass(order({ received_at: agoMs(AGE_WARN_MS) }), NOW), "age-warn"));

test("ten minutes goes red - opened or not", () => {
  assert.equal(ageClass(order({ received_at: agoMs(AGE_LATE_MS) }), NOW), "age-late");
  // An opened ticket is still being cooked and still ageing. It used to go
  // green on acceptance; that was a step that no longer exists.
  assert.equal(ageClass(order({ received_at: agoMs(AGE_LATE_MS), opened_at: agoMs(AGE_LATE_MS - 1000) }), NOW), "age-late");
  assert.equal(isLate(order({ received_at: agoMs(AGE_LATE_MS) }), NOW), true);
});

test("amber arrives when the office would be told", () => {
  // lib/health.ts raises the undelivered-order alert at five minutes. The
  // screen turning amber at the same moment is what makes the text that
  // follows make sense instead of arriving out of nowhere.
  assert.equal(AGE_WARN_MS, 5 * 60_000);
  assert.match(src("lib/health.ts"), /appUndeliveredMinutes: 5/);
});

test("a settled order is never late, however old", () => {
  // Colouring yesterday's completed orders red would teach a kitchen that red
  // means nothing, which costs the one order where it meant something.
  const old = { received_at: agoMs(9 * 3600_000) };
  assert.equal(ageClass(order({ ...old, status: "completed" }), NOW), "settled");
  assert.equal(ageClass(order({ ...old, status: "cancelled" }), NOW), "settled");
  assert.equal(isSettled(order({ status: "completed" })), true);
  assert.equal(isSettled(order({ accepted_at: "x" })), false, "acceptance is not settlement any more");
  assert.equal(isLate(order({ ...old, status: "completed" }), NOW), false);
});

test("the chime, the list and the late flag all let go at the same six hours", () => {
  // One window, three readers. If they drifted, a ticket could ring for
  // an order that is not on screen, or sit red on a list the chime had
  // given up on.
  const stale = order({ received_at: agoMs(STILL_ACTIONABLE_MS) });
  assert.equal(unaccepted([stale], NOW).length, 0, "the chime lets it go");
  assert.equal(bucketOf(stale, NOW, TZ), "past", "and so does the list");
  assert.equal(isLate(stale, NOW), false, "and so does the hero's red");
  assert.equal(ageClass(stale, NOW), "age-stale", "if it were ever painted, muted, not red");
  assert.equal(ageClass(order({ received_at: agoMs(STILL_ACTIONABLE_MS - 1) }), NOW), "age-late");
});

test("a missing or unreadable timestamp does not crash or colour", () => {
  assert.equal(ageClass(order({ received_at: null }), NOW), "age-calm");
  assert.equal(ageClass(order({ received_at: "not a date" }), NOW), "age-calm");
  assert.equal(elapsedLabel(order({ received_at: null }), NOW), "");
  assert.equal(bucketOf(order({ received_at: null }), NOW, TZ), "past", "no date: not in the kitchen");
});

console.log("\nthe timer:");

test("it counts up in m:ss, so it reads as live", () => {
  assert.equal(elapsedLabel(order({ received_at: agoMs(9_000) }), NOW), "0:09");
  assert.equal(elapsedLabel(order({ received_at: agoMs(131_000) }), NOW), "2:11");
});

test("it switches to hours rather than showing span:ss forever", () =>
  assert.equal(elapsedLabel(order({ received_at: agoMs(3 * 3600_000 + 25 * 60_000) }), NOW), "3h 25m"));

test("seconds are zero-padded, so the number does not change width", () =>
  assert.equal(elapsedLabel(order({ received_at: agoMs(65_000) }), NOW), "1:05"));

test("the dashboard ticks every second, or the timer is a lie", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /setNow\(Date\.now\(\)\), 1_000/);
  // Every card reads one clock, so they cannot disagree with each other.
  assert.match(dash, /now=\{now\}/);
  // And so does the ticket page.
  assert.match(src("components/OrderViewer.tsx"), /useTicking\(\)/);
});

console.log("\nthe card:");

test("one line of items: the first three, then an ellipsis", () => {
  const items = [{ name: "Catfish" }, { name: "Fries" }, { name: "Tea" }, { name: "Pie" }] as any;
  assert.equal(itemsLine(items), "Catfish · Fries · Tea …");
  assert.equal(itemsLine(items.slice(0, 2)), "Catfish · Fries");
  assert.equal(itemsLine([]), "");
  assert.equal(itemsLine(null), "");
  assert.equal(itemsLine([{ name: " " }] as any), "", "blank names are not items");
});

test("a card shows the six things and the pill - never where the order came from", () => {
  // Nick, 2026-09-15: the restaurant does not care which platform an order
  // arrived on, and cannot act on it. It stays in the data and the admin
  // views. The one exception is a test order, which says so quietly so that
  // nobody cooks it.
  const card = src("components/OrderCard.tsx");
  assert.doesNotMatch(card, /SOURCE_LABELS|Zuppler|"Email"/);
  assert.match(card, /order\.source === "test" && <span className="card-test">/);
  for (const fact of ["card-no", "card-type", "card-age", "card-name", "card-total", "card-items"]) {
    assert.match(card, new RegExp(`className=[{"]\`?${fact}`), `card must still show ${fact}`);
  }
  // The pill: the countdown once accepted, the flag (NEW) before.
  assert.match(card, /flag && <span className=\{`card-flag \$\{flag\.tone\}`\}>/);
  assert.match(card, /card-flag countdown \$\{cd\.phase\}/);
  assert.doesNotMatch(src("components/OrderViewer.tsx"), /order\.source(?!\s*===\s*"test")/, "the ticket view does not name the platform either");
});

console.log("\ntwo looks, one set of facts:");

test("an unknown display mode falls back to the loud one", () => {
  // The failure that costs money is a screen nobody notices, so a null, a
  // typo, or a column that has not been migrated must not produce the quiet
  // look by accident.
  for (const v of [null, undefined, "", "KITCHEN", "quiet", 0, {}]) {
    assert.equal(displayMode(v), "kitchen", `${JSON.stringify(v)} should fall back`);
  }
  assert.equal(displayMode("standard"), "standard");
});

test("the modes differ in size, never in what is on screen", () => {
  // The single property that makes two looks safe to have. Every rule under a
  // [data-display] selector may change type, spacing, colour or animation -
  // and none of them may hide anything.
  const css = src("app/globals.css");
  const scoped = [...css.matchAll(/\[data-display="(kitchen|standard)"\][^{]*\{([^}]*)\}/g)];
  assert.ok(scoped.length > 20, "expected the mode rules to be there");
  const hidden = scoped.filter(([, , body]) => /display:\s*none/.test(body));
  assert.deepEqual(hidden.map(([rule]) => rule.slice(0, 60)), [], "a mode must not hide information");
});

test("the age rail is keyed on age, not on status", () => {
  const css = src("app/globals.css");
  assert.match(css, /\.card\.age-late::before/);
  assert.match(css, /\.card\.age-stale::before/);
  assert.match(css, /\.card\.settled::before/);
});

test("only a late order breathes - a stale one is not an emergency", () => {
  const css = src("app/globals.css");
  const animated = [...css.matchAll(/([^{}]*)\{[^}]*animation: card-breathe[^}]*\}/g)].map((m) => m[1]);
  assert.ok(animated.length > 0);
  for (const sel of animated) assert.match(sel, /\.card\.age-late/);
  for (const sel of animated) assert.doesNotMatch(sel, /age-stale/);
});

test("the breathing card respects reduced motion", () => {
  const css = src("app/globals.css");
  const i = css.indexOf("prefers-reduced-motion");
  assert.ok(i > -1, "a kitchen screen that cannot stop moving gets turned off");
  assert.match(css.slice(i, i + 200), /animation: none/);
});

console.log("\npast week:");

const hist = (over: Record<string, any> = {}) => ({
  id: over.id ?? "h",
  order_number: "1",
  order_type: "pickup",
  customer_name: "A",
  customer_total: 10,
  status: "completed",
  source: "zuppler",
  received_at: agoMs(60_000),
  completed_at: agoMs(30_000),
  cancelled_at: null,
  ...over,
}) as any;

test("seven tiles, oldest first, ending today, in the restaurant's zone", () => {
  const days = weekHistory([], NOW, TZ);
  assert.equal(days.length, 7);
  assert.equal(days[6].label, "Today");
  assert.equal(days[5].label, "Yesterday");
  assert.equal(days[0].key, "2026-09-10");
  for (const d of days) assert.deepEqual([d.count, d.total, d.orders.length, d.truncated], [0, 0, 0, false]);
});

test("an order at 11:30 pm Central lands on the Central day, not the UTC one", () => {
  const lateNight = hist({ id: "ln", received_at: "2026-09-16T04:30:00Z", customer_total: 12.5 }); // 11:30 pm on the 15th, Central
  const days = weekHistory([lateNight], NOW, TZ);
  assert.equal(days.find((d) => d.key === "2026-09-15")?.count, 1);
  assert.equal(days.find((d) => d.key === "2026-09-16")?.count, 0);
  const utc = weekHistory([lateNight], NOW, "UTC");
  assert.equal(utc.find((d) => d.key === "2026-09-16")?.count, 1, "the same instant is the 16th in UTC");
});

test("counts and totals skip cancelled and test orders, but the rows stay", () => {
  const days = weekHistory(
    [
      hist({ id: "a", customer_total: 20 }),
      hist({ id: "b", customer_total: 5.25 }),
      hist({ id: "c", status: "cancelled", customer_total: 99 }),
      hist({ id: "d", source: "test", customer_total: 0 }),
    ],
    NOW,
    TZ
  );
  const today = days[6];
  assert.equal(today.count, 2);
  assert.equal(today.total, 25.25);
  assert.equal(today.orders.length, 4, "listed, marked, not counted");
  assert.equal(countsForHistory({ status: "cancelled", source: "zuppler" }), false);
  assert.equal(countsForHistory({ status: "new", source: "zuppler" }), true, "an order that aged out unfinished still counts as business done");
});

test("a day's orders are newest first and capped, with the cap named", () => {
  const many = Array.from({ length: HISTORY_DAY_CAP + 3 }, (_, i) => hist({ id: `m${i}`, received_at: agoMs(1000 * (i + 1)) }));
  const today = weekHistory(many, NOW, TZ)[6];
  assert.equal(today.orders.length, HISTORY_DAY_CAP);
  assert.equal(today.truncated, true);
  assert.equal(today.count, HISTORY_DAY_CAP + 3, "the count is the real count");
  assert.equal(today.orders[0].id, "m0", "newest first");
  assert.equal(HISTORY_DAY_CAP, 500);
});

test("anything outside the seven days is dropped, so the query may be generous", () => {
  const days = weekHistory([hist({ id: "old", received_at: "2026-09-01T12:00:00Z" })], NOW, TZ);
  assert.equal(days.reduce((n, d) => n + d.orders.length, 0), 0);
  assert.equal(historyWindowStart(NOW), new Date(NOW - 8 * 24 * 3600_000).toISOString());
});

test("money reads like money", () => {
  assert.equal(money(612.4), "$612.40");
  assert.equal(money(1234.5), "$1,234.50");
  assert.equal(money(0), "$0.00");
});

test("the route groups on the server, in the restaurant's zone, from the session", () => {
  const route = src("app/api/dashboard/history/route.ts");
  assert.match(route, /getCurrentUserRestaurantIds\(\)/);
  assert.match(route, /weekHistory\(orders \?\? \[\], now, timezone\)/);
  assert.match(route, /historyWindowStart\(now\)/);
  assert.doesNotMatch(route, /req\.json|searchParams/, "nothing is taken from the caller");
});

console.log("\nthe bridge:");

test("it refuses a mode the stylesheet does not know", () => {
  // An unrecognised value would leave a kitchen on an unstyled screen, which
  // is worse than either look.
  const route = src("app/api/crm/restaurants/[id]/route.ts");
  assert.match(route, /display_mode must be 'kitchen' or 'standard'/);
  assert.match(route, /updates\.display_mode = v/);
});

test("the restaurant list reports the current mode", () =>
  assert.match(src("lib/crm-roster.ts"), /display_mode: r\.display_mode \?\? "kitchen"/));

test("the setting cannot affect delivery, chiming or alerting", () => {
  // A display preference that could stop a restaurant getting its orders
  // would be a presentation change with an operational blast radius.
  for (const f of ["lib/canonical.ts", "lib/health.ts", "lib/kiosk.ts"]) {
    assert.doesNotMatch(src(f), /display_mode/, `${f} must not read display_mode`);
  }
});

console.log(`\n${passed} assertions passed.`);
