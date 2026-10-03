/**
 * Only a production Vercel build may migrate (ported from prs-crm #535). A
 * preview build of an unmerged PR must never run its migration against the
 * production database.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDbStepAllowed } from "./lib/build-db-gate.mjs";

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

console.log("the build-time migration gate:");

test("runs on a production Vercel build", () => {
  assert.deepEqual(buildDbStepAllowed({ VERCEL_ENV: "production" }), { run: true, env: "production" });
});

test("skips preview and development Vercel builds", () => {
  assert.deepEqual(buildDbStepAllowed({ VERCEL_ENV: "preview" }), { run: false, env: "preview" });
  assert.deepEqual(buildDbStepAllowed({ VERCEL_ENV: "development" }), { run: false, env: "development" });
  assert.equal(buildDbStepAllowed({ VERCEL_ENV: "Production" }).run, false);
});

test("runs off Vercel (laptop, CI), where VERCEL_ENV is unset", () => {
  assert.deepEqual(buildDbStepAllowed({}), { run: true, env: null });
  assert.deepEqual(buildDbStepAllowed({ VERCEL_ENV: "" }), { run: true, env: null });
});

test("migrate.mjs on a preview build logs the skip and exits 0 without connecting", () => {
  // An unreachable database: if the gate ever stopped working this fails on
  // the connection, and can never reach a real database.
  const unreachable = "postgres://gate-test:x@127.0.0.1:1/none";
  const res = spawnSync(process.execPath, [fileURLToPath(new URL("./migrate.mjs", import.meta.url))], {
    env: { ...process.env, VERCEL_ENV: "preview", MIGRATION_DATABASE_URL: unreachable },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(res.stderr, "");
  assert.equal(res.stdout.trim(), "migrations skipped (preview)");
  assert.equal(res.status, 0);
});

console.log(`\n${passed} passed`);
