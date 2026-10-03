/**
 * One-time backfill: orders.discounts from orders.raw_payload (migration 046,
 * prs-crm marketing engine, Matt 2026-10-02). Run by a person, never by a
 * deploy or a session.
 *
 * The live mapper fills discounts on every Zuppler order from now on, and a
 * re-delivered order picks them up through the ordinary adjustment path.
 * Every order ingested before that still has discounts = NULL although the
 * codes have been in raw_payload the whole time.
 *
 * Extraction is mapZupplerGraphqlOrder() itself - the same function the live
 * ingest runs, with the same `data.order ?? order ?? resp` fallback for the
 * shapes raw_payload was stored in - so the backfill cannot disagree with
 * what a new order would get. A Zuppler order with no discount gets [].
 *
 * Writing only `discounts` does not move updated_at (migration 046's trigger
 * change), so the tablets' incremental poll never pulls these old orders
 * back onto today's screen. Run it after 046 is applied.
 *
 * Zuppler orders only; email, phone and ezCater orders have no LoadOrder
 * payload. Idempotent: only touches rows where discounts IS NULL, and never
 * overwrites what the live mapper wrote meanwhile. Dry run by default;
 * --write applies. Set ZUPPLER_AMOUNTS the same as production (unset =
 * cents) - amount goes through the mapper's money(). Prints counts only:
 * never a code, a customer or a payload.
 *
 * Usage:
 *   tsx scripts/backfill-discounts.ts [--production] [--write]
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
  // the `discounts IS NULL` filter, so an offset would skip a page each time.
  let afterId = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  let withDiscount = 0;
  let withCode = 0;
  let none = 0;
  let updated = 0;
  let failed = 0;

  while (true) {
    const { data, error } = await client
      .from("orders")
      .select("id, raw_payload")
      .eq("source", "zuppler")
      .is("discounts", null)
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
      const discounts = mapZupplerGraphqlOrder(row.raw_payload).canonical.discounts ?? [];
      if (discounts.length === 0) none++;
      else withDiscount++;
      if (discounts.some((d) => d.promocode)) withCode++;
      if (WRITE) {
        const { error: updateError } = await client
          .from("orders")
          .update({ discounts })
          .eq("id", row.id)
          .is("discounts", null); // never overwrite what the live mapper wrote meanwhile
        if (updateError) {
          failed++;
          console.error(`  order ${row.id}: update failed - ${updateError.message}`);
        } else updated++;
      }
    }

    afterId = data[data.length - 1]!.id;
    console.log(`  scanned ${scanned} so far (this page: ${data.length})`);
    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\nScanned Zuppler orders: ${scanned}`);
  console.log(`With a discount: ${withDiscount} (with a promo code: ${withCode})`);
  console.log(`No discount (stored as []): ${none}`);
  if (WRITE) {
    console.log(`Updated: ${updated}`);
    if (failed) console.error(`WARNING: ${failed} update(s) failed -- see errors above.`);
  } else {
    console.log(`\nDry run only -- re-run with --write to apply.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
