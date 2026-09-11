#!/usr/bin/env node
/**
 * Applies any db/migrations/*.sql not yet recorded in schema_migrations, in
 * filename order, each inside its own transaction.
 *
 * Ported from prs-crm, which has run this way for months. Until now
 * migrations here were pasted into the Supabase SQL Editor by hand, and the
 * record of that going wrong is not hypothetical: of five applied in one
 * session, 021 silently never landed - leaving tablets chiming continuously
 * for two days - and 023 half-executed, because the editor runs only the
 * highlighted text when there is a selection.
 *
 * What this removes, in order of how much it hurt:
 *
 *  - Code shipping ahead of its schema. Migrations run in vercel-build BEFORE
 *    next build, so the two cannot get out of step. A failed migration fails
 *    the deploy, which is the point: better no deploy than code running
 *    against a schema that never changed.
 *  - "Did that one land?" A table answers it, and /api/health reports it.
 *  - Partial application. One transaction per file: it lands whole or not at
 *    all.
 *  - Double application. Recorded once, skipped thereafter - so the
 *    `if not exists` guards in the files become belt and braces rather than
 *    the only thing standing between us and a second run.
 *
 * What it does NOT remove, and nobody should assume it does: anything that
 * lives in the Supabase dashboard. Auth settings, the redirect allowlist and
 * email templates are not in this repo and are not touched by this.
 */
import { config } from "dotenv";
// Next auto-loads .env.local; plain dotenv does not. Match Next's convention
// explicitly so a local run reads the same file the app does.
config({ path: ".env.local" });
config();

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));

async function main() {
  /**
   * Deliberately its own variable, not the app's Supabase settings.
   *
   * The app talks to Supabase over PostgREST, which cannot execute DDL at
   * all - that is why these were hand-applied in the first place. This needs
   * a real Postgres connection, and specifically a SESSION-mode one (port
   * 5432, or a direct connection): migrations run DDL and keep bookkeeping
   * inside one BEGIN/COMMIT per file, which the transaction-mode pooler does
   * not reliably support.
   */
  const connectionString = process.env.MIGRATION_DATABASE_URL;

  if (!connectionString) {
    // Not an error. A deploy without it configured should still build - the
    // alternative is that adding this script breaks every deploy until
    // somebody sets a variable, which is a worse failure than the one it
    // fixes. /api/health reports the resulting gap, loudly and by name.
    console.warn(
      "MIGRATION_DATABASE_URL is not set - skipping migrations.\n" +
        "  Set it to the SESSION-mode connection string (port 5432) from\n" +
        "  Supabase -> Settings -> Database. Until then, migrations must be\n" +
        "  applied by hand and /api/health will name any that are missing."
    );
    return;
  }

  const pool = new pg.Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query("SELECT version FROM schema_migrations");
    const appliedSet = new Set(applied.map((r) => r.version));

    // Filename order, which is why they are numbered. Nothing infers
    // dependencies; 021 simply runs after 020.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Applying ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        // Exit non-zero so vercel-build stops here. Shipping code whose
        // migration just failed is the exact situation this exists to
        // prevent, and a half-migrated database with a full deploy on top of
        // it is worse than no deploy at all.
        console.error(`Migration ${file} failed, nothing from it was applied:`, err.message);
        process.exit(1);
      }
    }

    console.log(count === 0 ? "No pending migrations - up to date." : `Applied ${count} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration runner failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
