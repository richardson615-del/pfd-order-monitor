/**
 * GL1 teardown, bridge side: delete every synthetic row from the bridge DEV
 * database - the [GL] restaurants and everything that hangs off them (orders,
 * print jobs, devices, logins, heartbeats, audit rows), the GL-SIM tablets,
 * and the tablet logins in auth.
 *
 *   npx tsx scripts/golive/teardown.ts
 *
 * One transaction. Refuses a database that looks like production (db.ts
 * guardDatabase). Prints what it deleted, table by table.
 */
import { config } from "dotenv";
import { connect, glRestaurantIds, guardDatabase, teardown } from "./db";

async function main() {
  config({ path: ".env.golive" });
  const db = await connect();
  try {
    await guardDatabase(db);
    const before = (await glRestaurantIds(db)).length;
    const tally = await teardown(db);
    const after = (await glRestaurantIds(db)).length;
    console.log(`teardown: ${before} [GL] restaurants -> ${after}`);
    for (const [t, n] of Object.entries(tally).filter(([, n]) => n > 0).sort()) console.log(`  ${t}: ${n} deleted`);
    if (after !== 0) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
