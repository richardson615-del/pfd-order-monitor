/**
 * What a printer poll touches (lib/print-poll.ts). An idle printer must cost
 * one small read; anything that needs releasing or printing must still be
 * found on the very next poll - a printer that silently stops picking up
 * released jobs is worse than a slow database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pollPlan, shouldStampDevice } from "@/lib/print-poll";

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

const now = Date.parse("2026-11-11T21:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const o = { now, staleClaimMs: 2 * 60_000, holdRetryMs: 3 * 60_000 };

test("no open jobs: idle, no writes, no queued read", () => {
  assert.deepEqual(pollPlan([], o), { idle: true, staleClaimed: [], heldDue: [], readQueued: false });
});

test("a queued job: read it", () => {
  const p = pollPlan([{ id: "a", status: "queued", claimed_at: null, held_at: null }], o);
  assert.equal(p.idle, false);
  assert.equal(p.readQueued, true);
});

test("a fresh claim is left alone and the poll stays idle", () => {
  const p = pollPlan([{ id: "a", status: "claimed", claimed_at: ago(30_000), held_at: null }], o);
  assert.deepEqual(p, { idle: true, staleClaimed: [], heldDue: [], readQueued: false });
});

test("a stale claim is released and then read on the same poll", () => {
  const p = pollPlan([{ id: "a", status: "claimed", claimed_at: ago(3 * 60_000), held_at: null }], o);
  assert.deepEqual(p.staleClaimed, ["a"]);
  assert.equal(p.readQueued, true);
});

test("a hold is retried only after the hold window", () => {
  assert.equal(pollPlan([{ id: "h", status: "held", claimed_at: null, held_at: ago(60_000) }], o).idle, true);
  const due = pollPlan([{ id: "h", status: "held", claimed_at: null, held_at: ago(4 * 60_000) }], o);
  assert.deepEqual(due.heldDue, ["h"]);
  assert.equal(due.readQueued, true);
});

test("a claim or hold with no timestamp is never released by accident", () => {
  const p = pollPlan(
    [
      { id: "a", status: "claimed", claimed_at: null, held_at: null },
      { id: "h", status: "held", claimed_at: null, held_at: null },
    ],
    o
  );
  assert.equal(p.idle, true);
});

test("last_seen is written on the first poll, a version change, a new Eatabit name, and every 30s", () => {
  const base = { appVersion: "server-direct-print", printerName: null, wantPrinterName: null, now };
  assert.equal(shouldStampDevice({ ...base, lastSeenAt: null }), true);
  assert.equal(shouldStampDevice({ ...base, lastSeenAt: ago(5_000) }), false);
  assert.equal(shouldStampDevice({ ...base, lastSeenAt: ago(30_000) }), true);
  assert.equal(shouldStampDevice({ ...base, appVersion: "agent-2.1", lastSeenAt: ago(5_000) }), true);
  assert.equal(shouldStampDevice({ ...base, wantPrinterName: "Eatabit X", lastSeenAt: ago(5_000) }), true);
  assert.equal(shouldStampDevice({ ...base, printerName: "Eatabit X", wantPrinterName: "Eatabit X", lastSeenAt: ago(5_000) }), false);
});

test("the Epson route reads open jobs once and returns early when idle", () => {
  const src = readFileSync("app/api/print/epson/route.ts", "utf8");
  assert.match(src, /pollPlan\(/);
  assert.match(src, /if \(plan\.idle\) return empty\(\);/);
  assert.match(src, /shouldStampDevice\(/);
});

test("the monitor writes alerts in bulk, not one round trip per issue", () => {
  const src = readFileSync("app/api/monitor/check/route.ts", "utf8");
  assert.doesNotMatch(src, /for \(const i of issues\) \{\s*const \{ error \} = await admin\.from\("monitor_alerts"\)\.upsert/);
  assert.match(src, /upsert\(rows, \{ onConflict: "key" \}\)/);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
