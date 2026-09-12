/**
 * How an order reads on the tablet.
 *
 * Two looks as of 2026-09-11 - kitchen and standard, set per restaurant from
 * the CRM. The assertions worth having are not about pixels: they are that the
 * two modes never disagree about what is TRUE, that age only shouts about
 * orders somebody still has to act on, and that an unreadable setting falls
 * back to the loud look rather than the quiet one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGE_LATE_MS,
  AGE_WARN_MS,
  ageClass,
  displayMode,
  elapsedLabel,
  isSettled,
  orderFlag,
} from "@/lib/order-display";

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

const NOW = Date.parse("2026-09-11T19:00:00Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();
const order = (over: Record<string, any> = {}) =>
  ({
    id: "o1",
    status: "new",
    accepted_at: null,
    received_at: agoMs(60_000),
    ...over,
  }) as any;

console.log("an order only shouts while somebody has to act on it:");

test("a fresh order is calm", () =>
  assert.equal(ageClass(order(), NOW), "age-calm"));

test("five minutes unaccepted goes amber", () =>
  assert.equal(ageClass(order({ received_at: agoMs(AGE_WARN_MS) }), NOW), "age-warn"));

test("ten minutes unaccepted goes red", () =>
  assert.equal(ageClass(order({ received_at: agoMs(AGE_LATE_MS) }), NOW), "age-late"));

test("amber arrives when the office would be told", () => {
  // lib/health.ts raises the undelivered-order alert at five minutes. The
  // screen turning amber at the same moment is what makes the text that
  // follows make sense instead of arriving out of nowhere.
  assert.equal(AGE_WARN_MS, 5 * 60_000);
  assert.match(src("lib/health.ts"), /appUndeliveredMinutes: 5/);
});

test("an accepted order is never late, however old", () => {
  // Colouring yesterday's completed orders red would teach a kitchen that red
  // means nothing, which costs the one order where it meant something.
  const old = { received_at: agoMs(9 * 3600_000) };
  assert.equal(ageClass(order({ ...old, accepted_at: agoMs(8 * 3600_000) }), NOW), "settled");
  assert.equal(ageClass(order({ ...old, status: "completed" }), NOW), "settled");
  assert.equal(ageClass(order({ ...old, status: "cancelled" }), NOW), "settled");
});

test("a printed order still counts as waiting", () => {
  // Paper and the tablet are independent channels. A ticket having printed
  // says nothing about whether anybody here agreed to cook it.
  assert.equal(ageClass(order({ status: "printed", received_at: agoMs(AGE_LATE_MS) }), NOW), "age-late");
  assert.equal(orderFlag(order({ status: "printed" })).label, "Waiting");
});

test("opening an order does not settle it", () => {
  // Same rule the chime uses: a glance is not agreement to cook.
  assert.equal(isSettled(order({ status: "opened" })), false);
  assert.equal(orderFlag(order({ status: "opened" })).label, "Waiting");
});

test("a missing or unreadable timestamp does not crash or colour", () => {
  assert.equal(ageClass(order({ received_at: null }), NOW), "age-calm");
  assert.equal(ageClass(order({ received_at: "not a date" }), NOW), "age-calm");
  assert.equal(elapsedLabel(order({ received_at: null }), NOW), "");
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
  // and the only display:none is the tap hint, which is an affordance rather
  // than a fact about the order.
  const css = src("app/globals.css");
  const scoped = [...css.matchAll(/\[data-display="(kitchen|standard)"\][^{]*\{([^}]*)\}/g)];
  assert.ok(scoped.length > 20, "expected the mode rules to be there");
  const hidden = scoped.filter(([, , body]) => /display:\s*none/.test(body));
  for (const [rule] of hidden) {
    assert.match(rule, /\.card-tap/, `a mode must not hide information: ${rule.slice(0, 60)}`);
  }
});

test("the age rail is keyed on age, not on status", () => {
  const css = src("app/globals.css");
  assert.match(css, /\.card\.age-late::before/);
  assert.match(css, /\.card\.settled::before/);
});

test("the breathing card respects reduced motion", () => {
  const css = src("app/globals.css");
  const i = css.indexOf("prefers-reduced-motion");
  assert.ok(i > -1, "a kitchen screen that cannot stop moving gets turned off");
  assert.match(css.slice(i, i + 200), /animation: none/);
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
  assert.match(src("app/api/crm/restaurants/route.ts"), /display_mode: r\.display_mode \?\? "kitchen"/));

test("the setting cannot affect delivery, chiming or alerting", () => {
  // A display preference that could stop a restaurant getting its orders
  // would be a presentation change with an operational blast radius.
  for (const f of ["lib/canonical.ts", "lib/health.ts", "lib/kiosk.ts"]) {
    assert.doesNotMatch(src(f), /display_mode/, `${f} must not read display_mode`);
  }
});

console.log(`\n${passed} assertions passed.`);
