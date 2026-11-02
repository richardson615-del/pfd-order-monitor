/**
 * GL1 seed, bridge side: the synthetic market's restaurants, each with a
 * tablet login, a virtual Epson printer and a simulated tablet binding.
 *
 *   npx tsx scripts/golive/seed.ts [--restaurants 100] [--manifest file.json]
 *
 * It goes through the deployment's CRM routes - the same calls the CRM makes
 * when it onboards a restaurant - so a seed is also a test of onboarding:
 *
 *   POST /api/crm/restaurants                  find-or-create by crm_restaurant_id
 *   POST /api/crm/restaurants/:id/provision    active, app_expected, tablet login
 *   POST /api/crm/devices                      the virtual Epson (only if absent)
 *   POST /api/crm/tablets/bind                 GL-SIM-nnn -> the restaurant
 *
 * Idempotent: every call is find-or-create, and the device is created only
 * when the restaurant has none named GL_DEVICE_NAME. A second run changes
 * no row (the selftest proves it by counting).
 *
 * Without --manifest the CRM account ids are glCrmId(1..n)
 * ("91000000-0000-4000-8000-000000000001"...). The CRM's GL1 seed either
 * creates its accounts with the same ids, or writes its own manifest
 * ([{ crm_restaurant_id, name, zuppler_id? }]) and passes it here.
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { crm, pool } from "./http";
import { connect, type Db } from "./db";
import { preflight } from "./preflight";
import { GL_ACTOR, GL_DEVICE_NAME, parseManifest, syntheticRestaurants, type SyntheticRestaurant, DEFAULT_RESTAURANTS } from "./lib";

export interface SeedResult {
  restaurants: number;
  restaurantsCreated: number;
  loginsCreated: number;
  devicesCreated: number;
  bound: number;
  errors: string[];
}

export function arg(name: string, argv = process.argv): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function marketFromArgs(argv = process.argv): SyntheticRestaurant[] {
  const manifestPath = arg("manifest", argv);
  if (manifestPath) return syntheticRestaurants(0, parseManifest(JSON.parse(readFileSync(manifestPath, "utf8"))));
  return syntheticRestaurants(Number(arg("restaurants", argv) ?? DEFAULT_RESTAURANTS));
}

async function seedOne(r: SyntheticRestaurant, out: SeedResult): Promise<void> {
  const ensure = await crm("/api/crm/restaurants", {
    method: "POST",
    json: {
      crm_restaurant_id: r.crm_restaurant_id,
      name: r.name,
      zuppler_restaurant_id: r.zuppler_id,
      timezone: r.timezone,
      app_expected: true,
    },
  });
  if (!ensure.ok) throw new Error(`${r.name}: POST /api/crm/restaurants ${ensure.status} ${ensure.text.slice(0, 200)}`);
  if (ensure.body?.restaurant_created) out.restaurantsCreated++;

  const prov = await crm(`/api/crm/restaurants/${r.crm_restaurant_id}/provision`, { method: "POST", json: { actor: GL_ACTOR } });
  if (!prov.ok) throw new Error(`${r.name}: provision ${prov.status} ${prov.text.slice(0, 200)}`);
  if (prov.body?.login?.created) out.loginsCreated++;

  const printers: { name: string }[] = prov.body?.printers ?? [];
  if (!printers.some((p) => p.name === GL_DEVICE_NAME)) {
    const dev = await crm("/api/crm/devices", {
      method: "POST",
      json: { restaurant_id: r.crm_restaurant_id, name: GL_DEVICE_NAME, restaurant_name: r.name },
    });
    if (!dev.ok) throw new Error(`${r.name}: POST /api/crm/devices ${dev.status} ${dev.text.slice(0, 200)}`);
    out.devicesCreated++;
  }
}

/** The CRM's restaurant must have landed in the database the guards checked. */
async function canary(db: Db, r: SyntheticRestaurant): Promise<void> {
  const found = await db.query(`select 1 from restaurants where crm_restaurant_id::text = $1`, [r.crm_restaurant_id]);
  if (!found.rowCount) {
    throw new Error(
      `REFUSED: ${r.name} was created through the deployment but is not in GL_BRIDGE_DATABASE_URL - the deployment writes to a different database. Stop and check the preview's Supabase env.`
    );
  }
}

export async function seed(market: SyntheticRestaurant[], db: Db, log = console.log): Promise<SeedResult> {
  const out: SeedResult = { restaurants: market.length, restaurantsCreated: 0, loginsCreated: 0, devicesCreated: 0, bound: 0, errors: [] };
  // The first restaurant alone, then the canary, then the rest.
  const [first, ...rest] = market;
  await seedOne(first, out);
  await canary(db, first);
  await pool(rest, 5, async (r) => {
    try {
      await seedOne(r, out);
    } catch (err) {
      out.errors.push(err instanceof Error ? err.message : String(err));
    }
  });

  const bind = await crm("/api/crm/tablets/bind", {
    method: "POST",
    json: {
      actor: GL_ACTOR,
      bindings: market.map((r) => ({ device_ref: r.device_ref, restaurant_id: r.crm_restaurant_id, model: "GL simulated tablet" })),
    },
  });
  if (!bind.ok) out.errors.push(`tablets/bind ${bind.status} ${bind.text.slice(0, 200)}`);
  else {
    out.bound = Number(bind.body?.bound ?? 0);
    if (bind.body?.unknown_restaurants?.length) out.errors.push(`tablets/bind unknown restaurants: ${bind.body.unknown_restaurants.join(", ")}`);
  }
  log(
    `seed: ${market.length} restaurants (${out.restaurantsCreated} new), ${out.loginsCreated} logins new, ${out.devicesCreated} printers new, ${out.bound} tablets bound, ${out.errors.length} errors`
  );
  return out;
}

async function main() {
  config({ path: ".env.golive" });
  const market = marketFromArgs();
  const db = await connect();
  try {
    await preflight(db);
    const r = await seed(market, db);
    for (const e of r.errors) console.error(`  error: ${e}`);
    if (r.errors.length) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
