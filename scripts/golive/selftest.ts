/**
 * GL1 bridge selftest: the one command for the bridge side of the harness.
 *
 *   npx tsx scripts/golive/selftest.ts [--restaurants 100] [--manifest f.json] [--timeout-min 10]
 *
 * Against a gl/** preview on the bridge DEV database, it proves the GL1
 * acceptance for this repo and writes the evidence to
 * docs/research/golive-runs/<timestamp>-bridge-selftest.md:
 *
 *   B1  preflight: not production, dev-looking database, deployment == database
 *   B2  seed: every restaurant has a login, a virtual Epson and a bound tablet
 *   B3  seed is idempotent: a second run changes no row in any table
 *   B4  every restaurant's test order printed on its virtual Epson, exactly once
 *   B5  every test order reached its virtual tablet and was Accepted
 *   B6  teardown leaves zero rows: every table's count back to the start
 *
 * Any [GL] rows left by an earlier, interrupted run are torn down first.
 * Exit 1 unless every check passes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { config } from "dotenv";
import { call, crm, pool, sleep } from "./http";
import { connect, glJobs, glRestaurantIds, simTargets, tableCounts, teardown, type Db } from "./db";
import { preflight } from "./preflight";
import { arg, marketFromArgs, seed } from "./seed";
import { Simulator } from "./simulate";
import { diffCounts, overall, renderSelftestReport, stats, type Check, type Counts } from "./lib";

const fmtDiff = (d: ReturnType<typeof diffCounts>) => d.map((x) => `${x.table} ${x.before}→${x.after}`).join(", ");

async function run(db: Db, checks: Check[], notes: string[]) {
  const timeoutMs = Number(arg("timeout-min") ?? 10) * 60_000;
  const market = marketFromArgs();

  // B1
  const pre = await preflight(db);
  checks.push({
    id: "B1",
    name: "Preflight: not production, dev database, deployment on that database",
    verdict: "PASS",
    evidence: `${pre.baseUrl}; ${pre.activity.realRestaurants} non-GL restaurants, ${pre.activity.realOrders7d} real orders in 7 days; roster = database (${pre.restaurants} restaurants)`,
  });

  if ((await glRestaurantIds(db)).length) {
    const t = await teardown(db);
    notes.push(`Leftover [GL] rows from an earlier run were torn down first (${Object.values(t).reduce((a, b) => a + b, 0)} rows).`);
  }
  const start: Counts = await tableCounts(db);

  // B2
  const s1 = await seed(market, db);
  const after1 = await tableCounts(db);
  const targets = await simTargets(db);
  const complete = targets.filter((t) => t.device_key && t.username && t.password && t.device_ref);
  checks.push({
    id: "B2",
    name: `Seed ${market.length} restaurants through the CRM onboarding routes`,
    verdict: s1.errors.length === 0 && targets.length === market.length && complete.length === market.length ? "PASS" : "FAIL",
    evidence:
      `${targets.length}/${market.length} restaurants, ${complete.length} with login + virtual Epson + bound GL-SIM tablet; ` +
      `created ${s1.restaurantsCreated} restaurants, ${s1.loginsCreated} logins, ${s1.devicesCreated} printers` +
      (s1.errors.length ? `; errors: ${s1.errors.slice(0, 3).join(" / ")}` : ""),
  });

  // B3
  const s2 = await seed(market, db, () => {});
  const after2 = await tableCounts(db);
  const drift = diffCounts(after1, after2);
  checks.push({
    id: "B3",
    name: "Seed is idempotent (second run)",
    verdict: drift.length === 0 && s2.restaurantsCreated + s2.loginsCreated + s2.devicesCreated === 0 && s2.errors.length === 0 ? "PASS" : "FAIL",
    evidence: drift.length ? `row counts changed: ${fmtDiff(drift)}` : `no table changed; second run created ${s2.restaurantsCreated + s2.loginsCreated + s2.devicesCreated} rows`,
  });

  // B4 + B5: one test order per restaurant, devices running.
  const sim = new Simulator(complete);
  const since = new Date(Date.now() - 1000).toISOString();
  sim.start();
  await sleep(6_000); // let printers and tablets come up
  const sent = await pool(complete, 5, async (t) => {
    const r = await crm(`/api/crm/restaurants/${t.restaurant_id}/test-order`, { method: "POST" });
    return { restaurant: t.name, ok: r.ok, status: r.status, order_number: r.body?.order_number as string | undefined, order_id: r.body?.order_id as string | undefined };
  });
  const wanted = sent.filter((s) => s.ok && s.order_number);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const printed = new Set(sim.printed.map((p) => p.order_number));
    const seen = new Set(sim.seen.map((s) => s.order_number));
    const accepted = new Set(sim.accepted.filter((a) => a.status === 200).map((a) => a.order_id));
    const seenIds = new Map(sim.seen.map((s) => [s.order_number, s.order_id]));
    if (wanted.every((w) => printed.has(w.order_number) && seen.has(w.order_number) && accepted.has(seenIds.get(w.order_number)!))) break;
    await sleep(2_000);
  }
  await sleep(6_000); // a duplicate print would show up within one more poll
  await sim.stop();

  const printCount = new Map<string, number>();
  for (const p of sim.printed) if (p.order_number) printCount.set(p.order_number, (printCount.get(p.order_number) ?? 0) + 1);
  const notPrinted = wanted.filter((w) => !printCount.get(w.order_number!));
  const dupes = [...printCount.entries()].filter(([, n]) => n > 1);
  const failedSends = sent.filter((s) => !s.ok);
  checks.push({
    id: "B4",
    name: "Test order to every restaurant printed by its virtual Epson, exactly once",
    verdict: failedSends.length === 0 && notPrinted.length === 0 && dupes.length === 0 && wanted.length === complete.length ? "PASS" : "FAIL",
    evidence:
      `${wanted.length}/${complete.length} test orders sent, ${wanted.length - notPrinted.length} printed, ${dupes.length} printed twice` +
      (failedSends.length ? `; send failures: ${failedSends.slice(0, 3).map((f) => `${f.restaurant} ${f.status}`).join(", ")}` : "") +
      (notPrinted.length ? `; not printed: ${notPrinted.slice(0, 5).map((n) => n.order_number).join(", ")}` : "") +
      `; printer errors: ${sim.errors.filter((e) => e.device === "printer").length}`,
  });

  const seenNums = new Set(sim.seen.map((s) => s.order_number));
  const okAccepts = new Set(sim.accepted.filter((a) => a.status === 200).map((a) => a.order_id));
  const notSeen = wanted.filter((w) => !seenNums.has(w.order_number!));
  const notAccepted = wanted.filter((w) => !w.order_id || !okAccepts.has(w.order_id));
  const tabletErrors = sim.errors.filter((e) => e.device === "tablet");
  checks.push({
    id: "B5",
    name: "Every test order reached its virtual tablet and was Accepted",
    verdict: notSeen.length === 0 && notAccepted.length === 0 && wanted.length > 0 ? "PASS" : "FAIL",
    evidence:
      `${wanted.length - notSeen.length}/${wanted.length} seen, ${wanted.length - notAccepted.length} accepted (200); tablet errors: ${tabletErrors.length}` +
      (tabletErrors.length ? ` (first: ${tabletErrors[0].restaurant} ${tabletErrors[0].detail})` : ""),
  });

  const jobs = await glJobs(db, since);
  const printMs = jobs
    .filter((j) => j.delivery === "epson" && j.status === "printed" && j.queued_at && j.finished_at)
    .map((j) => new Date(j.finished_at!).getTime() - new Date(j.queued_at!).getTime());
  const printLatency = stats(printMs);
  const tabletLatency = stats(sim.seen.filter((s) => wanted.some((w) => w.order_number === s.order_number)).map((s) => s.ms));

  // B6
  const t = await teardown(db);
  const end = await tableCounts(db);
  const left = diffCounts(start, end);
  checks.push({
    id: "B6",
    name: "Teardown leaves zero rows (every table back to its starting count)",
    verdict: left.length === 0 ? "PASS" : "FAIL",
    evidence: left.length
      ? `left behind: ${fmtDiff(left)}`
      : `${Object.values(t).reduce((a, b) => a + b, 0)} rows deleted across ${Object.values(t).filter((n) => n > 0).length} tables; ${Object.keys(end).length} tables compared`,
  });

  return { printLatency, tabletLatency, restaurants: market.length };
}

async function main() {
  config({ path: ".env.golive" });
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  const notes: string[] = [];
  let printLatency = stats([]);
  let tabletLatency = stats([]);
  let restaurants = 0;
  const base = process.env.GL_BRIDGE_BASE_URL ?? "Data missing";
  let commit: string | null = null;
  try {
    const v = await call("/api/version");
    commit = v.body?.buildId ?? null;
  } catch {
    /* the preflight reports an unusable URL */
  }

  const db = await connect();
  try {
    const r = await run(db, checks, notes);
    ({ printLatency, tabletLatency, restaurants } = r);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ id: `B${checks.length + 1}`, name: "Run stopped", verdict: msg.startsWith("REFUSED") ? "BLOCKED" : "FAIL", evidence: msg });
    // Never leave synthetic rows behind on a failure after the preflight passed.
    if (checks.some((c) => c.id === "B1" && c.verdict === "PASS")) {
      try {
        await teardown(db);
        notes.push("Synthetic rows torn down after the failure.");
      } catch (e) {
        notes.push(`Teardown after the failure also failed: ${e instanceof Error ? e.message : e} - run scripts/golive/teardown.ts`);
      }
    }
  } finally {
    await db.end();
  }

  const finishedAt = new Date().toISOString();
  const md = renderSelftestReport({ startedAt, finishedAt, baseUrl: base, commit, restaurants, checks, printLatency, tabletLatency, notes });
  mkdirSync("docs/research/golive-runs", { recursive: true });
  const file = `docs/research/golive-runs/${startedAt.replace(/[:]/g, "").replace(/\.\d+Z$/, "Z")}-bridge-selftest.md`;
  writeFileSync(file, md + "\n");
  let local = "";
  try {
    local = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout */
  }
  console.log(md);
  console.log(`\nwritten: ${file}${local ? ` (local checkout ${local})` : ""}`);
  if (overall(checks) !== "PASS") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
