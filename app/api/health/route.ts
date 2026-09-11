import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { checkSchema } from "@/lib/schema-check";

export const dynamic = "force-dynamic";

/**
 * GET /api/health - UNAUTHENTICATED by design, the same as the CRM's.
 *
 * An uptime pinger cannot authenticate, and neither can somebody trying to
 * find out why the printers stopped at eight on a Friday. Read-only, cheap,
 * safe to poll, and it reports BOOLEANS and migration filenames only - never
 * a key, a connection string, a restaurant, or an order.
 *
 * It exists because migrations here are applied BY HAND in the Supabase SQL
 * Editor and nothing recorded which had been run. The only way to answer
 * "did that migration land?" was to write a query against information_schema
 * and know what to look for - so in practice the answer arrived when
 * something broke. This is the live print pipeline; that is too late.
 *
 * `schema` names the exact migration files to run rather than leaving whoever
 * is debugging to infer it from a crash. See lib/schema-check.ts for why it
 * probes the schema itself instead of keeping a schema_migrations table the
 * way the CRM does.
 *
 * 503 when something checked is false, so a pinger notices without parsing
 * the body.
 */
export async function GET() {
  // Cheap, and it is the connectivity check as well as a query: if the
  // database is unreachable this is what says so, rather than eighteen
  // schema probes all failing for the same reason.
  let database = false;
  try {
    const { error } = await supabaseAdmin().from("restaurants").select("id").limit(1);
    database = !error;
  } catch {
    database = false;
  }

  // Only worth probing if the database answered at all. Otherwise every
  // requirement comes back unknown and the response is noise on top of a
  // failure already reported.
  const schema = database
    ? await checkSchema()
    : { ok: true, missing: [] as string[], unchecked: 0 };

  const checks = {
    database,
    schema: schema.ok,
    // Names only, never values - the same rule lib/alerts.ts's smsConfigGaps
    // follows. A missing key and an empty one look identical otherwise.
    zuppler_webhook: Boolean(process.env.ZUPPLER_WEBHOOK_SECRET),
    push: Boolean(
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ),
  };

  const failing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  const body: Record<string, unknown> = { ok: failing.length === 0, checks };

  if (failing.length > 0) {
    body.failing = failing;
    if (!schema.ok) {
      body.schemaMismatch = {
        message:
          `This database is missing ${schema.missing.length} migration(s) the deployed code needs. ` +
          `Run them in the Supabase SQL Editor, in order.`,
        missingMigrations: schema.missing.map((m) => `db/migrations/${m}.sql`),
      };
    }
  }

  // Surfaced even when everything passes: probes that could not be run are
  // not failures, but "ok" while a third of the checks never happened is the
  // kind of green that gets trusted wrongly.
  if (schema.unchecked > 0) body.schemaUnchecked = schema.unchecked;

  return NextResponse.json(body, { status: failing.length === 0 ? 200 : 503 });
}
