/**
 * An eleven-day-old order printed at a restaurant on 2026-09-15, and the
 * office was paged with `ePOS code="EPTR_REC_EMPTY"`. Four rules stop the
 * four things that let that happen: a ticket too old to be wanted, a
 * reprint that hands back the retry budget, three retries in fifteen
 * seconds against an empty roll, and a code where a sentence belongs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  claimDecision,
  describePrinterCode,
  expiredReason,
  failureTransition,
  holdReleased,
  printMaxAgeMs,
  reprintResetsAttempts,
  reprintBy,
  DEFAULT_PRINT_MAX_AGE_HOURS,
  HOLD_MAX_MS,
  HOLD_RETRY_MS,
  MANUAL_REPRINT_GRACE_MS,
} from "../lib/print-policy";

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
const NOW = Date.parse("2026-09-16T23:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const maxAgeMs = DEFAULT_PRINT_MAX_AGE_HOURS * H;

console.log("how old is too old:");

test("four hours by default, from PRINT_MAX_AGE_HOURS when set, never zero or nonsense", () => {
  assert.equal(printMaxAgeMs({} as any), 4 * H);
  assert.equal(printMaxAgeMs({ PRINT_MAX_AGE_HOURS: "6" } as any), 6 * H);
  assert.equal(printMaxAgeMs({ PRINT_MAX_AGE_HOURS: "0" } as any), 4 * H);
  assert.equal(printMaxAgeMs({ PRINT_MAX_AGE_HOURS: "soon" } as any), 4 * H);
});

test("an order inside the window prints; one past it expires; the boundary prints", () => {
  assert.equal(claimDecision({ receivedAt: ago(20 * 60_000), manualReprintAt: null, now: NOW, maxAgeMs }), "print");
  assert.equal(claimDecision({ receivedAt: ago(4 * H), manualReprintAt: null, now: NOW, maxAgeMs }), "print");
  assert.equal(claimDecision({ receivedAt: ago(4 * H + 1), manualReprintAt: null, now: NOW, maxAgeMs }), "expire");
  assert.equal(claimDecision({ receivedAt: ago(11 * 24 * H), manualReprintAt: null, now: NOW, maxAgeMs }), "expire", "the Roundies ticket");
});

test("Print pressed in the last ten minutes overrides age - once, and not for a stale press", () => {
  const old = ago(11 * 24 * H);
  assert.equal(claimDecision({ receivedAt: old, manualReprintAt: ago(60_000), now: NOW, maxAgeMs }), "print");
  assert.equal(claimDecision({ receivedAt: old, manualReprintAt: ago(MANUAL_REPRINT_GRACE_MS), now: NOW, maxAgeMs }), "print");
  assert.equal(claimDecision({ receivedAt: old, manualReprintAt: ago(MANUAL_REPRINT_GRACE_MS + 1), now: NOW, maxAgeMs }), "expire");
  assert.equal(MANUAL_REPRINT_GRACE_MS, 10 * 60_000);
});

test("a document (no order) and an order with no date print rather than being guessed about", () => {
  assert.equal(claimDecision({ receivedAt: null, manualReprintAt: null, now: NOW, maxAgeMs }), "print");
  assert.equal(claimDecision({ receivedAt: "not a date", manualReprintAt: null, now: NOW, maxAgeMs }), "print");
});

test("the expired row says how old, in a person's units, and what to do if it is still wanted", () => {
  assert.match(expiredReason(ago(11 * 24 * H), NOW), /^Order was 11 days old when it reached the printer - not printed\. Use Print on the order/);
  assert.match(expiredReason(ago(7 * H), NOW), /7 hours old/);
});

console.log("\na reprint of an old order gets one shot:");

test("a recent order's reprint resets attempts; an old one's does not", () => {
  assert.equal(reprintResetsAttempts({ receivedAt: ago(H), now: NOW, maxAgeMs }), true);
  assert.equal(reprintResetsAttempts({ receivedAt: ago(5 * H), now: NOW, maxAgeMs }), false);
  assert.equal(reprintResetsAttempts({ receivedAt: null, now: NOW, maxAgeMs }), true);
});

test("the queue marks who asked, dates a manual press, and only resets attempts when the policy says", () => {
  const q = src("lib/print-queue.ts");
  assert.match(q, /queued_by: opts\.queuedBy/);
  assert.match(q, /manual_reprint_at: manualReprintAt/);
  assert.match(q, /\.\.\.\(resetAttempts \? \{ attempts: 0 \} : \{\}\)/);
  assert.match(q, /reprintResetsAttempts\(\{ receivedAt: opts\.receivedAt/);
  assert.doesNotMatch(q, /^\s*attempts: 0,\s*$/m, "attempts is no longer reset unconditionally");
  assert.equal(reprintBy("tablet"), "reprint:tablet");
  assert.equal(reprintBy("  "), "reprint:unknown");
});

test("every insert says who queued it: ingest, test, login_print, reprint:<actor>", () => {
  assert.match(src("lib/canonical.ts"), /device_id: d\.id, queued_by: "ingest"/);
  assert.match(src("lib/test-order.ts"), /queueOrderToPrinters\(order\.id, restaurant\.id, \{ queuedBy: "test" \}\)/);
  assert.match(src("app/api/crm/devices/[id]/route.ts"), /queued_by: "test"/);
  assert.match(src("app/api/crm/restaurants/[id]/logins/print/route.ts"), /queued_by: "login_print"/);
  const tablet = src("app/api/orders/[id]/print/route.ts");
  assert.match(tablet, /queuedBy: reprintBy\("tablet"\)/);
  assert.match(tablet, /receivedAt: order\.received_at \?\? null/, "the age decides whether the retries come back");
  assert.match(src("db/migrations/038_print_job_age_and_provenance.sql"), /add column if not exists queued_by text/);
});

console.log("\nthe printer's codes, in English:");

test("the codes a kitchen actually hits", () => {
  assert.deepEqual(describePrinterCode("EPTR_REC_EMPTY"), { code: "EPTR_REC_EMPTY", message: "Printer is out of paper", hold: true });
  assert.deepEqual(describePrinterCode("EPTR_COVER_OPEN"), { code: "EPTR_COVER_OPEN", message: "Printer cover is open", hold: true });
  assert.equal(describePrinterCode("EPTR_REC_NEAR_END").message, "Paper is running low");
  assert.equal(describePrinterCode("EPTR_REC_NEAR_END").hold, false, "low is a warning, not a reason to stop");
  assert.equal(describePrinterCode("SchemaError").message, "Printer offline or misconfigured");
  assert.equal(describePrinterCode("EX_TIMEOUT").message, "Printer offline");
  assert.equal(describePrinterCode("").message, "Printer offline", "no code at all is the printer not answering");
});

test("an unknown code is shown, not hidden", () => {
  assert.equal(describePrinterCode("EPTR_SOMETHING_NEW").message, "Printer error EPTR_SOMETHING_NEW");
  assert.equal(describePrinterCode("EPTR_SOMETHING_NEW").hold, false);
});

console.log("\nout of paper holds, it does not retry:");

test("out of paper parks the job without spending an attempt", () => {
  const t = failureTransition({ code: "EPTR_REC_EMPTY", attempts: 0, heldSince: null, now: NOW });
  assert.equal(t.status, "held");
  assert.equal(t.attempts, 0);
  assert.equal(t.error, "Printer is out of paper (EPTR_REC_EMPTY)");
  // Again and again, still zero attempts - the printer is waiting for a person.
  assert.equal(failureTransition({ code: "EPTR_REC_EMPTY", attempts: 0, heldSince: ago(30 * 60_000), now: NOW }).status, "held");
});

test("an hour of being held fails it, with the reason and how long", () => {
  const t = failureTransition({ code: "EPTR_REC_EMPTY", attempts: 0, heldSince: ago(HOLD_MAX_MS), now: NOW });
  assert.equal(t.status, "failed");
  assert.equal(t.error, "Printer is out of paper for over an hour (EPTR_REC_EMPTY)");
  assert.equal(HOLD_MAX_MS, 60 * 60_000);
});

test("any other failure is a real attempt: queued twice, failed the third time, in English", () => {
  const first = failureTransition({ code: "SchemaError", attempts: 0, heldSince: null, now: NOW });
  assert.deepEqual(first, { status: "queued", attempts: 1, error: "Printer offline or misconfigured (SchemaError)" });
  assert.equal(failureTransition({ code: "SchemaError", attempts: 1, heldSince: null, now: NOW }).status, "queued");
  assert.equal(failureTransition({ code: "SchemaError", attempts: 2, heldSince: null, now: NOW }).status, "failed");
});

test("a held job is offered again two minutes after its last hold, not on the very next poll", () => {
  assert.equal(holdReleased(ago(HOLD_RETRY_MS - 1), NOW), false);
  assert.equal(holdReleased(ago(HOLD_RETRY_MS), NOW), true);
  assert.equal(holdReleased(null, NOW), true);
  assert.equal(HOLD_RETRY_MS, 2 * 60_000);
});

console.log("\nboth transports obey the same rules:");

for (const [name, path] of [
  ["Epson Server Direct Print", "app/api/print/epson/route.ts"],
  ["the pull agent", "app/api/print/jobs/route.ts"],
] as const) {
  test(`${name}: expires at claim time, releases holds, and turns a result into held/queued/failed through the policy`, () => {
    const route = src(path);
    assert.match(route, /claimDecision\(\{ receivedAt: j\.orders\?\.received_at, manualReprintAt: j\.manual_reprint_at, now: nowMs, maxAgeMs \}\) === "expire"/);
    assert.match(route, /status: "expired", error: expiredReason\(/);
    assert.match(route, /\.eq\("status", "held"\)[\s\S]*?\.lt\("held_at", new Date\((nowMs|Date\.now\(\)) - HOLD_RETRY_MS\)/);
    assert.match(route, /failureTransition\(\{ code(: |, )/);
    assert.match(route, /held_at: nowIso, held_since: job\.held_since \?\? nowIso/);
    assert.doesNotMatch(route, /attempts < 3/, "the retry rule lives in the policy, not the route");
    assert.doesNotMatch(route, /ePOS code=/, "no raw code reaches the row on its own");
  });
}

test("expired is never a health issue; held is pending with its reason; failed leads with the sentence", () => {
  const health = src("lib/health.ts");
  assert.match(health, /\.in\("status", \["queued", "claimed", "held", "failed"\]\)/);
  assert.doesNotMatch(health, /"expired"/);
  assert.match(health, /j\.status === "held" && j\.error/);
  assert.match(health, /title: reason \? `\$\{reason\}: order/);
  assert.match(health, /order: issueOrder\(j\.order, now\)/);
});

test("the migration adds the two states and the four columns, nullable and undefaulted", () => {
  const m = src("db/migrations/038_print_job_age_and_provenance.sql");
  assert.match(m, /check \(status in \('queued', 'claimed', 'printed', 'failed', 'held', 'expired', 'failed_acknowledged'\)\)/);
  for (const col of ["queued_by text", "manual_reprint_at timestamptz", "held_since timestamptz", "held_at timestamptz"]) {
    assert.match(m, new RegExp(`add column if not exists ${col}`), col);
  }
  const sql = m.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /add column[^;]*(not null|default)/i);
});

test("the contract tells the CRM about order, the titles, expiry and holds", () => {
  const doc = src("docs/crm-bridge-contract.md");
  assert.match(doc, /carry an \*\*`order`\*\* object/);
  assert.match(doc, /Printer is out of paper: order 1196/);
  assert.match(doc, /PRINT_MAX_AGE_HOURS/);
  assert.match(src("app/api/crm/issues/route.ts"), /order: i\.order \?\? null/);
});

console.log(`\n${passed} assertions passed.`);
