/**
 * The order ready timer (PA5, Matt 2026-10-26): Accept with minutes, READY,
 * Running late, the countdown to ready_by, and the CRM feed carrying all of
 * it. The pure rules are exercised directly; the route, the tablet and the
 * contract are checked by reading their source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countdown, heroSummary, kitchenSort, newlyOver } from "../lib/countdown";
import {
  READY_MINUTE_CHOICES,
  RUNNING_LATE_STEPS,
  isReady,
  parseOrderPatch,
  readyByFor,
  readyChoices,
  refuseReadyChange,
  runningLateMinutes,
} from "../lib/ready-timer";
import { orderTimeline, shapeOrderRow, type OrderRowInput } from "../lib/crm-orders";

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
const NOW = Date.parse("2026-10-27T23:30:00Z");
const M = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

console.log("the PATCH body:");

test("accept with or without minutes; ready; re-time; the old statuses; nonsense refused", () => {
  assert.deepEqual(parseOrderPatch({ accepted: true }), { ok: true, patch: { kind: "accept", minutes: null } });
  assert.deepEqual(parseOrderPatch({ accepted: true, minutes: 15 }), { ok: true, patch: { kind: "accept", minutes: 15 } });
  assert.deepEqual(parseOrderPatch({ ready: true }), { ok: true, patch: { kind: "ready" } });
  assert.deepEqual(parseOrderPatch({ minutes: 35 }), { ok: true, patch: { kind: "retime", minutes: 35 } });
  assert.deepEqual(parseOrderPatch({ status: "completed" }), { ok: true, patch: { kind: "status", status: "completed" } });
  for (const bad of [0, 181, 12.5, "20", -5]) {
    const r = parseOrderPatch({ accepted: true, minutes: bad });
    assert.equal(r.ok, false, `minutes ${String(bad)}`);
    assert.equal((r as any).code, "invalid_minutes");
  }
  assert.equal((parseOrderPatch({ ready: true, minutes: 10 }) as any).code, "invalid_body");
  assert.equal((parseOrderPatch({ status: "accepted" }) as any).code, "invalid_status");
  assert.equal((parseOrderPatch(null) as any).code, "invalid_status");
  assert.equal((parseOrderPatch({}) as any).code, "invalid_status");
  // minutes: null is "not sent", not an error.
  assert.deepEqual(parseOrderPatch({ accepted: true, minutes: null }), { ok: true, patch: { kind: "accept", minutes: null } });
});

test("ready_by is accepted_at + minutes; an unreadable accepted_at gives none", () => {
  assert.equal(readyByFor("2026-10-27T23:00:00.000Z", 20), "2026-10-27T23:20:00.000Z");
  assert.equal(readyByFor(null, 20), null);
  assert.equal(readyByFor("not a date", 20), null);
});

test("what may be re-timed or marked ready", () => {
  const base = { accepted_at: at(NOW - 5 * M), ready_by: at(NOW + 15 * M), ready_at: null, status: "new" };
  assert.equal(refuseReadyChange(base, "retime"), null);
  assert.equal(refuseReadyChange(base, "ready"), null);
  assert.equal(refuseReadyChange({ ...base, accepted_at: null }, "retime")?.code, "not_accepted");
  assert.equal(refuseReadyChange({ ...base, accepted_at: null }, "ready"), null, "Ready on an unaccepted order accepts it too");
  assert.equal(refuseReadyChange({ ...base, ready_at: at(NOW) }, "retime")?.code, "already_ready");
  assert.equal(refuseReadyChange({ ...base, status: "completed" }, "ready")?.code, "order_completed");
  assert.equal(refuseReadyChange({ ...base, status: "cancelled" }, "retime")?.code, "order_cancelled");
});

console.log("\nthe tablet's choices:");

test("quick picks 10/15/20/25/30/45, with the restaurant's own target added in order", () => {
  assert.deepEqual([...READY_MINUTE_CHOICES], [10, 15, 20, 25, 30, 45]);
  assert.deepEqual(readyChoices(25), [10, 15, 20, 25, 30, 45]);
  assert.deepEqual(readyChoices(35), [10, 15, 20, 25, 30, 35, 45]);
  assert.deepEqual(readyChoices(0), [10, 15, 20, 25, 30, 45], "a nonsense target is not added");
  assert.deepEqual([...RUNNING_LATE_STEPS], [5, 10]);
});

test("running late: N more minutes from the ready time, or from now once it has passed", () => {
  const accepted = NOW - 10 * M;
  // ready_by 20 min after accept (10 from now): +5 -> 25.
  assert.equal(runningLateMinutes({ accepted_at: at(accepted), ready_by: at(accepted + 20 * M) }, 5, 25, NOW), 25);
  // already 3 minutes over (ready_by = accept + 7): +10 -> 10 min from now = 20 from accept.
  assert.equal(runningLateMinutes({ accepted_at: at(accepted), ready_by: at(accepted + 7 * M) }, 10, 25, NOW), 20);
  // no ready_by (accepted before 055): from accept + prep target.
  assert.equal(runningLateMinutes({ accepted_at: at(accepted), ready_by: null }, 5, 25, NOW), 30);
  // rounds up a part minute.
  assert.equal(runningLateMinutes({ accepted_at: at(accepted - 30_000), ready_by: at(accepted + 20 * M) }, 5, 25, NOW), 26);
  // past the ceiling, or not accepted: nothing to send.
  assert.equal(runningLateMinutes({ accepted_at: at(NOW - 178 * M), ready_by: at(NOW) }, 5, 25, NOW), null);
  assert.equal(runningLateMinutes({ accepted_at: null, ready_by: null }, 5, 25, NOW), null);
});

console.log("\nthe countdown:");

const order = (id: string, over: Record<string, any> = {}) => ({
  id,
  status: "new" as const,
  received_at: at(NOW - 15 * M),
  accepted_at: at(NOW - 10 * M) as string | null,
  ready_by: null as string | null,
  ready_at: null as string | null,
  ...over,
});

test("runs to ready_by when the kitchen chose the minutes; to accept + prep otherwise", () => {
  const chosen = countdown(order("a", { ready_by: at(NOW + 5 * M) }), 25, NOW)!;
  assert.equal(chosen.dueAt, NOW + 5 * M);
  assert.equal(chosen.label, "05:00");
  const old = countdown(order("b"), 25, NOW)!;
  assert.equal(old.dueAt, NOW + 15 * M, "accepted 10 min ago, 25-minute target");
  const bad = countdown(order("c", { ready_by: "garbage" }), 25, NOW)!;
  assert.equal(bad.dueAt, NOW + 15 * M, "an unreadable ready_by falls back");
});

test("READY ends the countdown: no pill, not over, no chime, sorted after the ones still cooking", () => {
  const ready = order("r", { ready_by: at(NOW - 5 * M), ready_at: at(NOW - M) });
  assert.equal(countdown(ready, 25, NOW), null);
  assert.equal(isReady(ready), true);
  const over = new Set<string>();
  assert.deepEqual(newlyOver([ready], 25, NOW, over), []);
  const cooking = order("k", { ready_by: at(NOW + 2 * M) });
  assert.deepEqual(kitchenSort([ready, cooking], 25, NOW).map((o) => o.id), ["k", "r"]);
  const hero = heroSummary([ready], 25, NOW, 10 * M);
  assert.equal(hero.next, null);
  assert.notEqual(hero.tone, "late", "a ready order is not late");
});

console.log("\nthe CRM feed:");

const row: OrderRowInput = {
  id: "o1",
  order_number: "1001",
  source: "zuppler",
  status: "new",
  restaurant_id: "r1",
  received_at: at(NOW - 15 * M),
  opened_at: null,
  accepted_at: at(NOW - 10 * M),
  ready_minutes: 20,
  ready_by: at(NOW + 10 * M),
  ready_at: null,
  completed_at: null,
  cancelled_at: null,
  printed_at: null,
  due_time: null,
  order_type: "delivery",
  payment_type: null,
  channel_id: null,
  customer_name: "A",
  customer_phone: null,
  items: [],
  customer_total: 10,
};

test("list rows carry ready_minutes, ready_by and ready_at; older rows read as null", () => {
  const shaped = shapeOrderRow(row, { id: "r1", crm_restaurant_id: "acct", name: "R" }, [], NOW);
  assert.equal(shaped.ready_minutes, 20);
  assert.equal(shaped.ready_by, row.ready_by);
  assert.equal(shaped.ready_at, null);
  const { ready_minutes, ready_by, ready_at, ...pre055 } = row;
  const old = shapeOrderRow(pre055 as OrderRowInput, { id: "r1", crm_restaurant_id: "acct", name: "R" }, [], NOW);
  assert.equal(old.ready_minutes, null);
  assert.equal(old.ready_by, null);
  assert.equal(old.ready_at, null);
  // overtime follows ready_by, not the prep target.
  const late = shapeOrderRow({ ...row, ready_by: at(NOW - M) }, { id: "r1", crm_restaurant_id: "acct", name: "R" }, [], NOW);
  assert.equal(late.flags.overtime, true);
  const readyRow = shapeOrderRow({ ...row, ready_by: at(NOW - M), ready_at: at(NOW - 2 * M) }, { id: "r1", crm_restaurant_id: "acct", name: "R" }, [], NOW);
  assert.equal(readyRow.flags.overtime, false, "ready is not overtime");
});

test("the timeline says when it was ready", () => {
  const t = orderTimeline({ ...row, ready_at: at(NOW - M) }, []);
  assert.deepEqual(t.map((e) => e.event), ["received", "accepted", "ready"]);
});

test("the feed selects the columns, the migration adds them, the route and tablet use them, the contract says so", () => {
  assert.match(src("lib/crm-orders-data.ts"), /accepted_at, ready_minutes, ready_by, ready_at,/);
  const m = src("db/migrations/055_order_ready_timer.sql");
  assert.match(m, /add column if not exists ready_minutes integer/);
  assert.match(m, /add column if not exists ready_by timestamptz/);
  assert.match(m, /add column if not exists ready_at timestamptz/);
  assert.match(m, /ready_minutes is null or ready_minutes between 1 and 180/);
  assert.match(src("lib/expected-migrations.ts"), /"055_order_ready_timer\.sql"/);
  const route = src("app/api/orders/[id]/route.ts");
  assert.match(route, /parseOrderPatch/);
  assert.match(route, /\.is\("accepted_at", null\)/, "accept still never rewrites accepted_at");
  assert.match(route, /\.is\("ready_at", null\)/, "ready is stamped once");
  // SC1: readyBy is accepted_at + minutes, except on a scheduled order (the hand-off).
  assert.match(route, /readyBy = readyByFor\(now, minutes\)/);
  assert.match(route, /ready_by: readyBy\b/);
  const card = src("components/OrderCard.tsx");
  assert.match(card, /className="btn card-ready"/);
  assert.match(card, /readyChoices\(prepMinutes\)/);
  assert.match(card, /RUNNING_LATE_STEPS/);
  const viewer = src("components/OrderViewer.tsx");
  assert.match(viewer, /patch\(\{ ready: true \}/);
  assert.match(viewer, /patch\(\{ minutes \}/);
  assert.match(viewer, /"Complete"/, "Complete is still its own button");
  const contract = src("docs/crm-bridge-contract.md");
  assert.match(contract, /ready_by/);
  assert.match(contract, /ready_at/);
  assert.match(contract, /ready_minutes/);
});

console.log(`\n${passed} assertions passed.`);
