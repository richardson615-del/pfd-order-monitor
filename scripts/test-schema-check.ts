/**
 * Assertions for the schema tripwire.
 *
 * Migrations here are pasted into the Supabase SQL Editor by hand, and until
 * now nothing recorded which had been run - so "did that migration land?" was
 * answered by something breaking. This is the live print pipeline.
 *
 * The rules pull against each other and both directions are tested. It has to
 * name a genuinely missing migration, and it has to stay quiet through a
 * network blip: a health check that cries wolf is one people learn to ignore,
 * and being ignored is the only way this fails at its job.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
  REQUIRED_SCHEMA,
  classifyProbe,
  summariseSchema,
  type SchemaRequirement,
} from "@/lib/schema-check";

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

const req = (over: Partial<SchemaRequirement> = {}): SchemaRequirement => ({
  migration: "021_order_accepted",
  table: "orders",
  column: "accepted_at",
  ...over,
});

console.log("reading a probe:");

test("no error means the column is there", () =>
  assert.equal(classifyProbe(null), "present"));

test("Postgres undefined_column and undefined_table both mean missing", () => {
  assert.equal(classifyProbe({ code: "42703" }), "missing");
  assert.equal(classifyProbe({ code: "42P01" }), "missing");
});

test("PostgREST schema-cache misses mean missing too", () => {
  // What actually surfaces when a column was added but the cache has not
  // caught up - or was never added at all.
  for (const code of ["PGRST202", "PGRST204", "PGRST205"]) {
    assert.equal(classifyProbe({ code }), "missing", `${code} should read as missing`);
  }
});

test("the message is read when there is no usable code", () => {
  assert.equal(
    classifyProbe({ message: 'column orders.accepted_at does not exist' }),
    "missing"
  );
  assert.equal(
    classifyProbe({ message: "Could not find the 'accepted_at' column of 'orders'" }),
    "missing"
  );
});

test("anything unrecognised is UNKNOWN, never missing", () => {
  // The load-bearing one. A timeout, a 500, a dropped connection must not be
  // reported as a missing migration - that is how a tripwire gets muted
  // before the day it matters.
  for (const e of [
    { code: "57014", message: "canceling statement due to statement timeout" },
    { message: "fetch failed" },
    { code: "PGRST301", message: "JWT expired" },
    {},
  ]) {
    assert.equal(classifyProbe(e), "unknown", `${JSON.stringify(e)} must not read as missing`);
  }
});

console.log("\nsummarising:");

test("all present is ok with nothing to run", () => {
  const s = summariseSchema([
    { requirement: req(), result: "present" },
    { requirement: req({ migration: "020_app_delivery" }), result: "present" },
  ]);
  assert.deepEqual(s, { ok: true, missing: [], unchecked: 0 });
});

test("a missing column names its migration", () => {
  const s = summariseSchema([{ requirement: req(), result: "missing" }]);
  assert.equal(s.ok, false);
  assert.deepEqual(s.missing, ["021_order_accepted"]);
});

test("one migration with two missing columns is reported once", () => {
  // 020 adds a column to two tables. Telling someone to run it twice would
  // read as two separate problems.
  const s = summariseSchema([
    { requirement: req({ migration: "020_app_delivery", table: "restaurants", column: "app_expected" }), result: "missing" },
    { requirement: req({ migration: "020_app_delivery", table: "print_jobs", column: "delivered_count" }), result: "missing" },
  ]);
  assert.deepEqual(s.missing, ["020_app_delivery"]);
});

test("missing migrations come back in order, so they can be run top to bottom", () => {
  const s = summariseSchema([
    { requirement: req({ migration: "021_order_accepted" }), result: "missing" },
    { requirement: req({ migration: "017_email_delivery" }), result: "missing" },
    { requirement: req({ migration: "020_app_delivery" }), result: "missing" },
  ]);
  assert.deepEqual(s.missing, ["017_email_delivery", "020_app_delivery", "021_order_accepted"]);
});

test("unknown probes never become missing, and are counted", () => {
  const s = summariseSchema([
    { requirement: req(), result: "unknown" },
    { requirement: req({ migration: "020_app_delivery" }), result: "unknown" },
  ]);
  assert.equal(s.ok, true, "a database we could not reach is not a missing migration");
  assert.deepEqual(s.missing, []);
  assert.equal(s.unchecked, 2);
});

console.log("\nthe requirements themselves:");

test("every requirement names a real migration file", () => {
  const files = new Set(
    readdirSync(new URL("../db/migrations/", import.meta.url)).map((f) => f.replace(/\.sql$/, ""))
  );
  for (const r of REQUIRED_SCHEMA) {
    assert.ok(
      files.has(r.migration),
      `${r.migration} is listed but db/migrations/${r.migration}.sql does not exist`
    );
  }
});

test("the migrations this session added are covered", () => {
  const covered = new Set(REQUIRED_SCHEMA.map((r) => r.migration));
  for (const m of ["017_email_delivery", "020_app_delivery", "021_order_accepted"]) {
    assert.ok(covered.has(m), `${m} is not checked by anything`);
  }
});

test("no requirement is blank", () => {
  for (const r of REQUIRED_SCHEMA) {
    assert.ok(r.migration && r.table && r.column, `incomplete requirement: ${JSON.stringify(r)}`);
  }
});

console.log(`\n${passed} assertions passed.`);
