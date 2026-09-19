/**
 * One-time backfill: orders.customer_email from orders.raw_payload.
 *
 * Migration 041 added the column and the live mapper now populates it on
 * every NEW Zuppler order (lib/zuppler-mapper.ts) -- but every order
 * ingested BEFORE that fix still has customer_email = NULL despite email
 * having been present in Zuppler's response the whole time, sitting
 * unread in raw_payload. This is prs-crm's Marketing & Pricing pillar's
 * launch asset (docs/marketing-pricing-spec.md, Phase 1): months of real
 * customer emails, already collected, never extracted.
 *
 * Re-uses the SAME extraction logic the live mapper uses
 * (mapZupplerGraphqlOrder's own `resp?.data?.order ?? resp?.order ?? resp`
 * fallback chain) rather than assuming one fixed JSON shape for
 * raw_payload -- the stored shape varies by how it was captured
 * (sometimes the full GraphQL envelope, sometimes just the order object),
 * and a single hardcoded JSON path would silently miss whichever shape it
 * didn't anticipate.
 *
 * Zuppler source only (source='zuppler') -- the email-leg (AEM) parser
 * never captured an email at all, so there's nothing to extract from an
 * email-sourced row's raw_html.
 *
 * Idempotent: only touches rows where customer_email IS NULL. Running
 * this twice, or after the live mapper has already started filling new
 * rows in, is always a no-op on anything already populated.
 *
 * Usage:
 *   tsx scripts/backfill-customer-email.ts [--production] [--write]
 * Without --write, nothing is updated -- only counts are printed.
 * Without --production, targets whatever .env.local points at (dev).
 */
import { config } from "dotenv";
const isProduction = process.argv.includes("--production");
config({ path: isProduction ? ".env.production.local" : ".env.local" });
config();

import { createClient } from "@supabase/supabase-js";

const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 500; // same safe-chunk size confirmed against this project's own row cap, 2026-09-19

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
    process.exit(1);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Same fallback chain as mapZupplerGraphqlOrder -- see this file's header comment on why. */
function extractEmail(rawPayload: unknown): string | null {
  const resp = rawPayload as any;
  const order = resp?.data?.order ?? resp?.order ?? resp ?? {};
  const carts = Array.isArray(order.carts) ? order.carts : order.carts ? [order.carts] : [];
  const customer = carts[0]?.customer ?? {};
  return str(customer.email);
}

async function main() {
  const client = admin();
  console.log(`Target: ${isProduction ? "PRODUCTION" : "dev"}  Mode: ${WRITE ? "WRITE" : "dry run"}\n`);

  let offset = 0;
  let scanned = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let noEmailFound = 0;

  while (true) {
    const { data, error } = await client
      .from("orders")
      .select("id, raw_payload")
      .eq("source", "zuppler")
      .is("customer_email", null)
      .not("raw_payload", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("query failed:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      const email = extractEmail(row.raw_payload);
      if (!email) {
        noEmailFound++;
        continue;
      }
      wouldUpdate++;
      if (WRITE) {
        const { error: updateError } = await client
          .from("orders")
          .update({ customer_email: email })
          .eq("id", row.id);
        if (updateError) {
          console.error(`  order ${row.id}: update failed - ${updateError.message}`);
        } else {
          updated++;
        }
      }
    }

    console.log(`  scanned ${scanned} so far (this page: ${data.length}, offset ${offset})`);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`\nScanned: ${scanned}`);
  console.log(`Real email found in raw_payload: ${wouldUpdate}`);
  console.log(`No email in raw_payload (genuinely absent, not an extraction failure -- Zuppler doesn't require one): ${noEmailFound}`);
  if (WRITE) {
    console.log(`Updated: ${updated}`);
    if (updated !== wouldUpdate) console.error(`WARNING: ${wouldUpdate - updated} update(s) failed -- see errors above.`);
  } else {
    console.log(`\nDry run only -- re-run with --write to apply.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
