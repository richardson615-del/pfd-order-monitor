import { supabaseAdmin } from "./supabase-server";
import { EXPECTED_MIGRATIONS } from "./expected-migrations";

/**
 * Does the live database have every migration this deployment expects?
 *
 * This used to probe the schema itself - one PostgREST query per column a
 * migration adds - and the comment explaining why was emphatic: migrations
 * were pasted in by hand, nothing would keep a bookkeeping table honest, and
 * a table that quietly disagrees with the database is more dangerous than no
 * table because it gets believed.
 *
 * That reasoning was right, and what changed is its premise. scripts/migrate.mjs
 * is now the only thing that applies a migration, and it records each one in
 * the same transaction that applies it. The table cannot drift from the
 * database without the transaction having failed, in which case neither
 * happened. So it is no longer bookkeeping somebody maintains; it is a
 * by-product of the act itself.
 *
 * The probe is gone rather than kept alongside. Two sources of truth for one
 * question is how they start disagreeing, and this one is now cheaper too:
 * one query instead of eighteen, on an endpoint an uptime pinger polls.
 */

export interface SchemaStatus {
  ok: boolean;
  /** Migration filenames to run, in order. */
  missing: string[];
  /** True when the record could not be read at all - not the same as missing. */
  unreadable: boolean;
}

export async function checkSchema(): Promise<SchemaStatus> {
  try {
    const { data, error } = await supabaseAdmin().from("schema_migrations").select("version");

    if (error) {
      // Either the runner has never run here, or the table cannot be read.
      // Reported as its own state rather than as "every migration is
      // missing": listing all twenty-four as outstanding would be true in the
      // first case, alarming nonsense in the second, and indistinguishable
      // from the outside.
      return { ok: false, missing: [], unreadable: true };
    }

    const applied = new Set((data ?? []).map((r: { version: string }) => r.version));
    const missing = EXPECTED_MIGRATIONS.filter((v) => !applied.has(v));
    return { ok: missing.length === 0, missing, unreadable: false };
  } catch {
    return { ok: false, missing: [], unreadable: true };
  }
}
