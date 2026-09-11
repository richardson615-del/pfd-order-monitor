import { supabaseAdmin } from "./supabase-server";

/**
 * Does the live database have what this deployment needs?
 *
 * The CRM answers this by reading a schema_migrations table its own runner
 * maintains. That approach cannot work here and copying it would have made
 * things worse: migrations in this repo are pasted into the Supabase SQL
 * Editor by hand, so nothing would keep such a table honest. A bookkeeping
 * table that quietly disagrees with the database is more dangerous than no
 * table, because it is believed.
 *
 * So this checks the schema ITSELF. Each requirement names one thing a
 * migration adds and the migration that adds it, and the probe goes through
 * the same PostgREST client the app uses - meaning it tests exactly what a
 * real request would hit, including the schema cache, rather than what
 * information_schema says is theoretically present.
 *
 * The failure names the file to run. That is the whole point: "021 is
 * missing" is actionable, "a query crashed" is not.
 */

export interface SchemaRequirement {
  /** The migration file that adds it, named verbatim so it can be run. */
  migration: string;
  table: string;
  /** One column the migration adds. A missing TABLE fails the same probe. */
  column: string;
}

/**
 * Load-bearing schema only: things whose absence breaks a code path that
 * ships today. Not every migration appears here, and it is not meant to -
 * this is a tripwire for "the code and the database disagree", not an
 * inventory. A migration that only backfills data adds nothing to probe and
 * is deliberately absent (022 is the current example; the README carries the
 * query for it).
 */
export const REQUIRED_SCHEMA: readonly SchemaRequirement[] = [
  { migration: "002_multi_source_print", table: "orders", column: "source" },
  { migration: "003_tip_and_delivery_fee", table: "orders", column: "tip" },
  { migration: "005_monitor_alerts", table: "monitor_alerts", column: "key" },
  { migration: "007_crm_restaurant_link", table: "restaurants", column: "crm_restaurant_id" },
  { migration: "008_webhook_receipts", table: "webhook_receipts", column: "status" },
  { migration: "009_ticket_footer", table: "restaurants", column: "ticket_footer_text" },
  { migration: "010_ticket_text_scale", table: "restaurants", column: "ticket_text_scale" },
  { migration: "011_ticket_design", table: "restaurants", column: "ticket_design_style" },
  { migration: "012_ticket_branding", table: "restaurants", column: "ticket_logo_b64" },
  { migration: "013_smart_footer", table: "restaurants", column: "footer_engine" },
  { migration: "014_zuppler_ids_and_printer_expected", table: "restaurants", column: "printer_expected" },
  { migration: "016_accounting_capture", table: "orders", column: "money_variance" },
  { migration: "017_email_delivery", table: "print_jobs", column: "delivery" },
  { migration: "018_cancellation_lifecycle", table: "orders", column: "cancelled_at" },
  { migration: "019_statement_sends", table: "statement_sends", column: "status" },
  { migration: "020_app_delivery", table: "restaurants", column: "app_expected" },
  { migration: "020_app_delivery", table: "print_jobs", column: "delivered_count" },
  { migration: "021_order_accepted", table: "orders", column: "accepted_at" },
] as const;

export type ProbeResult = "present" | "missing" | "unknown";

/**
 * Reads one probe's error into a verdict.
 *
 * Deliberately conservative about what counts as MISSING. Anything that is
 * not recognisably "this column or table does not exist" comes back
 * `unknown`, because a health endpoint that reports a missing migration
 * during a network blip teaches people to ignore it - and the one thing this
 * has to survive is being ignored.
 *
 * Several shapes mean the same thing here and all are accepted: Postgres's
 * own undefined_column (42703) and undefined_table (42P01), and PostgREST's
 * schema-cache misses (PGRST202/204/205), which is what actually surfaces
 * when a column was added but the cache has not caught up.
 */
export function classifyProbe(
  error: { code?: string | null; message?: string | null } | null | undefined
): ProbeResult {
  if (!error) return "present";
  const code = (error.code ?? "").toUpperCase();
  if (code === "42703" || code === "42P01") return "missing";
  if (code === "PGRST202" || code === "PGRST204" || code === "PGRST205") return "missing";
  const message = (error.message ?? "").toLowerCase();
  if (/(column|relation|table).*does not exist/.test(message)) return "missing";
  if (/could not find .*(column|table)/.test(message)) return "missing";
  return "unknown";
}

export interface SchemaStatus {
  ok: boolean;
  /** Migration files to run, de-duplicated and in order. */
  missing: string[];
  /** Requirements that could not be checked at all - never reported as missing. */
  unchecked: number;
}

/** Turns probe verdicts into the answer, without needing a database. */
export function summariseSchema(
  results: { requirement: SchemaRequirement; result: ProbeResult }[]
): SchemaStatus {
  const missing = [
    ...new Set(
      results.filter((r) => r.result === "missing").map((r) => r.requirement.migration)
    ),
  ].sort();
  return {
    ok: missing.length === 0,
    missing,
    unchecked: results.filter((r) => r.result === "unknown").length,
  };
}

/**
 * Probes every requirement. One `limit(1)` per row of REQUIRED_SCHEMA, run
 * concurrently - cheap enough for an endpoint an uptime pinger will poll,
 * and it reads nothing but whether the column resolves.
 */
export async function checkSchema(): Promise<SchemaStatus> {
  const admin = supabaseAdmin();
  const results = await Promise.all(
    REQUIRED_SCHEMA.map(async (requirement) => {
      try {
        const { error } = await admin
          .from(requirement.table)
          .select(requirement.column)
          .limit(1);
        return { requirement, result: classifyProbe(error) };
      } catch (err: any) {
        return { requirement, result: classifyProbe(err) };
      }
    })
  );
  return summariseSchema(results);
}
