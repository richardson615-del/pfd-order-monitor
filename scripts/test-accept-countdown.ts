/**
 * Accept, then a countdown (I3, Nick 2026-09-17).
 *
 * "Order comes in -> they click Accept to stop the notification -> a
 * 25-minute countdown starts -> they can click Complete to finish sooner."
 * Everything here is the pure half of that: what chimes, what the pill
 * says at 25:00, at 4:59, at 0:00 and at -3:12, how the list sorts, what
 * the hero line reads, and what the restaurant's prep target may be.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COUNTDOWN_AMBER_MS,
  DEFAULT_PREP_MINUTES,
  MAX_PREP_MINUTES,
  MIN_PREP_MINUTES,
  countdown,
  heroSummary,
  isUnaccepted,
  isValidPrepMinutes,
  kitchenSort,
  newlyOver,
  prepMinutesOf,
  prepTimeLabel,
} from "../lib/countdown";
import { unaccepted } from "../lib/kiosk";
import { AGE_LATE_MS } from "../lib/order-display";
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

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-09-17T23:30:00Z"); // 6:30 PM Chicago
const M = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const o = (id: string, over: Record<string, any> = {}) => ({
  id,
  status: "new" as Order["status"],
  received_at: at(NOW - 3 * M),
  opened_at: null as string | null,
  accepted_at: null as string | null,
  completed_at: null as string | null,
  cancelled_at: null as string | null,
  ...over,
});

console.log("the prep target:");

test("25 by default; the CRM's value when it is a whole number of minutes in range; the default otherwise", () => {
  assert.equal(DEFAULT_PREP_MINUTES, 25);
  assert.equal(prepMinutesOf(undefined), 25);
  assert.equal(prepMinutesOf(null), 25);
  assert.equal(prepMinutesOf(30), 30);
  assert.equal(prepMinutesOf("40"), 40, "a column read back as text still counts");
  assert.equal(prepMinutesOf(0), 25);
  assert.equal(prepMinutesOf(181), 25);
  assert.equal(prepMinutesOf(12.5), 25);
  assert.equal(isValidPrepMinutes(MIN_PREP_MINUTES), true);
  assert.equal(isValidPrepMinutes(MAX_PREP_MINUTES), true);
  assert.equal(isValidPrepMinutes(0), false);
  assert.equal(isValidPrepMinutes("30"), false, "the CRM sends a number, not a string");
  const m = src("db/migrations/040_restaurant_prep_minutes.sql");
  assert.match(m, /add column if not exists prep_minutes integer not null default 25/);
  assert.match(m, /check \(prep_minutes between 1 and 180\)/);
});

console.log("\nwhat chimes:");

test("a new order chimes until Accept; opening the ticket changes nothing; Accept stops it", () => {
  assert.equal(unaccepted([o("a")], NOW).length, 1);
  assert.equal(unaccepted([o("a", { status: "opened", opened_at: at(NOW - M) })], NOW).length, 1);
  assert.equal(unaccepted([o("a", { accepted_at: at(NOW - M) })], NOW).length, 0);
  assert.equal(isUnaccepted(o("a")), true);
  assert.equal(isUnaccepted(o("a", { accepted_at: at(NOW - M) })), false);
  assert.equal(isUnaccepted(o("a", { status: "cancelled" })), false);
});

test("the six-hour ceiling still holds - an abandoned order does not ring forever", () => {
  assert.equal(unaccepted([o("a", { received_at: at(NOW - 6 * 60 * M) })], NOW).length, 0);
  assert.equal(unaccepted([o("a", { received_at: at(NOW - 5 * 60 * M) })], NOW).length, 1);
});

console.log("\nthe countdown:");

test("none before Accept or after Complete/cancel; from Accept it runs from accepted_at + prep", () => {
  assert.equal(countdown(o("a"), 25, NOW), null);
  assert.equal(countdown(o("a", { status: "completed", accepted_at: at(NOW - 10 * M) }), 25, NOW), null);
  assert.equal(countdown(o("a", { status: "cancelled", accepted_at: at(NOW - 10 * M) }), 25, NOW), null);
  const c = countdown(o("a", { accepted_at: at(NOW) }), 25, NOW)!;
  assert.equal(c.label, "25:00");
  assert.equal(c.phase, "calm");
  assert.equal(c.remainingMs, 25 * M);
  assert.equal(c.dueAt, NOW + 25 * M);
});

test("calm until five minutes left, amber under five, red at zero and counting up", () => {
  const acceptedAt = at(NOW - 20 * M); // 5:00 left exactly
  assert.equal(countdown(o("a", { accepted_at: acceptedAt }), 25, NOW)!.phase, "calm", "5:00 on the nose is still calm");
  assert.equal(countdown(o("a", { accepted_at: acceptedAt }), 25, NOW + 1)!.phase, "amber");
  assert.equal(countdown(o("a", { accepted_at: acceptedAt }), 25, NOW + 1)!.label, "04:59");
  assert.equal(countdown(o("a", { accepted_at: at(NOW - 25 * M + 1000) }), 25, NOW)!.label, "00:01");
  assert.equal(countdown(o("a", { accepted_at: at(NOW - 25 * M) }), 25, NOW)!.phase, "over", "red at 0:00 (Nick)");
  assert.equal(countdown(o("a", { accepted_at: at(NOW - 25 * M) }), 25, NOW)!.label, "+0:00 over");
  const over = countdown(o("a", { accepted_at: at(NOW - 25 * M - 192_000) }), 25, NOW)!;
  assert.equal(over.phase, "over");
  assert.equal(over.label, "+3:12 over");
  assert.equal(over.remainingMs, -192_000);
  assert.equal(COUNTDOWN_AMBER_MS, 5 * M);
});

test("the restaurant's own target is what it counts from", () => {
  assert.equal(countdown(o("a", { accepted_at: at(NOW) }), 40, NOW)!.label, "40:00");
  assert.equal(countdown(o("a", { accepted_at: at(NOW) }), 0, NOW)!.label, "25:00", "nonsense falls back to the default");
});

test("it survives a reload: nothing but accepted_at, the target and the clock go in", () => {
  const lib = src("lib/countdown.ts");
  const fn = lib.slice(lib.indexOf("export function countdown("), lib.indexOf("export const isUnaccepted"));
  assert.doesNotMatch(fn, /Date\.now\(\)|setInterval|setTimeout|localStorage/);
});

console.log("\nthe list and the hero line:");

test("unaccepted first, oldest first; then accepted by least time left (most over on top)", () => {
  const list = [
    o("acc-late", { accepted_at: at(NOW - 10 * M) }), // 15:00 left
    o("new-2", { received_at: at(NOW - 2 * M) }),
    o("acc-over", { accepted_at: at(NOW - 30 * M) }), // 5:00 over
    o("new-9", { received_at: at(NOW - 9 * M) }),
    o("acc-soon", { accepted_at: at(NOW - 22 * M) }), // 3:00 left
  ];
  assert.deepEqual(kitchenSort(list, 25, NOW).map((x) => x.id), ["new-9", "new-2", "acc-over", "acc-soon", "acc-late"]);
});

test("'3 orders · 1 not accepted · next up in 04:10'", () => {
  const list = [
    o("n", { received_at: at(NOW - 2 * M) }),
    o("a1", { accepted_at: at(NOW - (25 * M - 250_000)) }), // 4:10 left
    o("a2", { accepted_at: at(NOW - 5 * M) }),
  ];
  const h = heroSummary(list, 25, NOW, AGE_LATE_MS);
  assert.equal(h.text, "3 orders · 1 not accepted · next up in 04:10");
  assert.equal(h.tone, "busy");
  assert.equal(heroSummary([list[1], list[2]], 25, NOW, AGE_LATE_MS).text, "2 orders · next up in 04:10");
  assert.equal(heroSummary([list[0]], 25, NOW, AGE_LATE_MS).text, "1 order · 1 not accepted");
  assert.equal(heroSummary([], 25, NOW, AGE_LATE_MS).text, "All clear");
  assert.equal(heroSummary([], 25, NOW, AGE_LATE_MS).tone, "idle");
});

test("red when an unaccepted order is late, or any countdown is over; the over one leads", () => {
  assert.equal(heroSummary([o("n", { received_at: at(NOW - AGE_LATE_MS) })], 25, NOW, AGE_LATE_MS).tone, "late");
  const over = heroSummary([o("a", { accepted_at: at(NOW - 30 * M) }), o("b", { accepted_at: at(NOW - 2 * M) })], 25, NOW, AGE_LATE_MS);
  assert.equal(over.tone, "late");
  assert.equal(over.text, "2 orders · +5:00 over");
});

console.log("\nthe single chime at zero:");

test("each order chimes once when it crosses zero; what is already over on load is not announced; a fresh Accept re-arms it", () => {
  const seen = new Set<string>();
  const early = [o("a", { accepted_at: at(NOW - 20 * M) })];
  assert.deepEqual(newlyOver(early, 25, NOW, seen).map((x) => x.id), []);
  assert.deepEqual(newlyOver(early, 25, NOW + 5 * M + 1000, seen).map((x) => x.id), ["a"], "crossed zero");
  assert.deepEqual(newlyOver(early, 25, NOW + 6 * M, seen).map((x) => x.id), [], "not again");
  // A screen that loads with an order already over seeds the set silently.
  const loaded = new Set<string>();
  newlyOver([o("b", { accepted_at: at(NOW - 40 * M) })], 25, NOW, loaded);
  assert.ok(loaded.has("b"));
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /if \(overRef\.current === null\) \{[\s\S]*?newlyOver\(kitchen, prepMinutes, now, overRef\.current\);\s*return;/, "seeded on first look, not announced");
  assert.match(dash, /if \(crossed\.length && soundArmed\) playOvertimeTone\(\)/);
  assert.match(src("lib/sound.ts"), /export function playOvertimeTone\(\)/);
});

console.log("\nComplete records the real prep time:");

test("'17 min' from Accept to Complete; nothing without both; never negative", () => {
  assert.equal(prepTimeLabel(at(NOW - 17 * M), at(NOW)), "17 min");
  assert.equal(prepTimeLabel(at(NOW - 17 * M - 29_000), at(NOW)), "17 min", "rounded to the minute");
  assert.equal(prepTimeLabel(null, at(NOW)), null);
  assert.equal(prepTimeLabel(at(NOW), at(NOW - M)), null);
  const row = src("components/CompletedRow.tsx");
  assert.match(row, /`Accepted \$\{timeLabel\(order\.accepted_at, timezone\)\} · Done \$\{timeLabel\(order\.completed_at \?\? order\.received_at, timezone\)\} \(\$\{prep\}\)`/);
});

console.log("\nthe screens:");

test("the card: NEW + Accept before, the countdown pill after; the ticket: Accept then Complete, countdown large", () => {
  const card = src("components/OrderCard.tsx");
  assert.match(card, /className="btn card-accept"/);
  assert.match(card, /\{waiting && onAccept && \(/);
  assert.match(card, /card-flag countdown \$\{cd\.phase\} num/);
  const viewer = src("components/OrderViewer.tsx");
  assert.match(viewer, /ticket-accept/);
  assert.match(viewer, /\{busy \? "Accepting…" : "Accept"\}/);
  assert.match(viewer, /\{busy \? "Completing…" : "Complete"\}/);
  assert.match(viewer, /ticket-countdown num \$\{cd\.phase\}/);
  assert.doesNotMatch(viewer, /"Done"/);
  // Accept is the existing PATCH { accepted: true }, which never rewrites accepted_at.
  assert.match(src("app/api/orders/[id]/route.ts"), /\.is\("accepted_at", null\)/);
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /body: JSON\.stringify\(\{ accepted: true \}\)/);
  assert.match(dash, /onAccept=\{accept\}/);
});

test("the prep target travels: the pages read it, the CRM can set it, the contract says so", () => {
  assert.match(src("app/dashboard/page.tsx"), /prepMinutes=\{prepMinutesOf\(restaurant\?\.prep_minutes\)\}/);
  assert.match(src("app/order/[id]/page.tsx"), /prepMinutes=\{prepMinutesOf\(restaurant\?\.prep_minutes\)\}/);
  const crm = src("app/api/crm/restaurants/[id]/route.ts");
  assert.match(crm, /if \("prep_minutes" in body\)/);
  assert.match(crm, /code: "invalid_prep_minutes"/);
  assert.match(src("lib/crm-roster.ts"), /prep_minutes: prepMinutesOf\(r\.prep_minutes\)/);
  assert.match(src("docs/crm-bridge-contract.md"), /`prep_minutes` \| whole minutes the tablet counts down from \*\*Accept\*\*/);
});

console.log(`\n${passed} assertions passed.`);
