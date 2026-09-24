/**
 * One-time backfill: orders.line_items from orders.raw_payload
 * (migration 044, prs-crm QUEUE row 66).
 *
 * The live mapper fills line_items on every Zuppler order from now on, and
 * a re-delivered order picks them up through the ordinary adjustment path.
 * Every order ingested before that still has line_items = NULL although the
 * lines have been in raw_payload the whole time.
 *
 * Extraction is mapZupplerGraphqlOrder() itself - the same function the live
 * ingest runs, with the same `data.order ?? order ?? resp` fallback for the
 * shapes raw_payload was stored in - so the backfill cannot disagree with
 * what a new order would get. (backfill-customer-email.ts copied the
 * fallback chain instead; that is the one thing not repeated here.)
 *
 * Zuppler orders only; email and phone orders have no LoadOrder payload.
 * Idempotent: only touches rows where line_items IS NULL. Dry run by
 * default; --write applies. Set ZUPPLER_AMOUNTS the same as production
 * (unset = cents) - item_total goes through the mapper's money().
 *
 * Usage:
 *   tsx scripts/backfill-line-items.ts [--production] [--write]
 */
import { config } from "dotenv";
const isProduction = process.argv.includes("--production");
config({ path: isProduction ? ".env.production.local" : ".env.local" });
config();

import { createClient } from "@supabase/supabase-js";
import { mapZupplerGraphqlOrder } from "@/lib/zuppler-mapper";

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 500; // this project's safe per-request chunk (see accounting/orders)

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
    process.exit(1);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const client = admin();
  console.log(`Target: ${isProduction ? "PRODUCTION" : "dev"}  Mode: ${WRITE ? "WRITE" : "dry run"}\n`);

  // Keyset on id, not offset: in --write mode every filled row drops out of
  // the `line_items IS NULL` filter, so an offset would skip a page each time.
  let afterId = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  let found = 0;
  let updated = 0;
  let noLines = 0;

  while (true) {
    const { data, error } = await client
      .from("orders")
      .select("id, raw_payload")
      .eq("source", "zuppler")
      .is("line_items", null)
      .not("raw_payload", "is", null)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (error) {
      console.error("query failed:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      const lineItems = mapZupplerGraphqlOrder(row.raw_payload).canonical.lineItems ?? null;
      if (!lineItems) {
        noLines++;
        continue;
      }
      found++;
      if (WRITE) {
        const { error: updateError } = await client
          .from("orders")
          .update({ line_items: lineItems })
          .eq("id", row.id)
          .is("line_items", null); // never overwrite what the live mapper wrote meanwhile
        if (updateError) console.error(`  order ${row.id}: update failed - ${updateError.message}`);
        else updated++;
      }
    }

    afterId = data[data.length - 1]!.id;
    console.log(`  scanned ${scanned} so far (this page: ${data.length})`);
    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\nScanned: ${scanned}`);
  console.log(`Line items found in raw_payload: ${found}`);
  console.log(`No cart lines in raw_payload: ${noLines}`);
  if (WRITE) {
    console.log(`Updated: ${updated}`);
    if (updated !== found) console.error(`WARNING: ${found - updated} update(s) failed -- see errors above.`);
  } else {
    console.log(`\nDry run only -- re-run with --write to apply.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
