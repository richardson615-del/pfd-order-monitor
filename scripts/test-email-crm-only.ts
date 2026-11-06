/**
 * Paper-ticket email, CRM orders only (migration 057, Nick 2026-11-06).
 *
 * With restaurants.email_crm_orders_only on, the PC-inbox ticket email goes
 * only for CRM (phone / P-) orders; a Zuppler order skips it, and the CRM's
 * "Where it went" says "Skipped — restaurant receives Zuppler email
 * directly". Off = exactly the old behaviour. Resend follows the same rule.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMAIL_SKIP_TEXT, emailSkipReason, isCrmOrder } from "../lib/email-routing";
import { emailSummary } from "../lib/crm-orders";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const on = { email_crm_orders_only: true };
const off = { email_crm_orders_only: false };
const zuppler = { source: "zuppler", order_number: "AB12CD" };
const zupplerByEmail = { source: "email", order_number: "AB12CD" };
const phone = { source: "phone", order_number: "P-7F3A21" };

console.log("the rule:");
test("toggle on: a Zuppler order is skipped, in the words the brief asked for", () => {
  assert.equal(emailSkipReason(on, zuppler), "zuppler");
  assert.equal(emailSkipReason(on, zupplerByEmail), "zuppler", "the older Zuppler-email ingest is a Zuppler order too");
  assert.equal(EMAIL_SKIP_TEXT.zuppler, "Skipped — restaurant receives Zuppler email directly");
});
test("toggle on: a phone (P-) order is sent; a test order is sent so the PC can still be checked", () => {
  assert.equal(emailSkipReason(on, phone), null);
  assert.equal(emailSkipReason(on, { source: "test", order_number: "TEST-1" }), null);
  assert.equal(isCrmOrder(phone), true);
});
test("toggle on: any other source (ezCater, Uber Eats) is not a CRM order and is skipped with its own reason", () => {
  assert.equal(emailSkipReason(on, { source: "ezcater", order_number: "GJ3P08" }), "not_crm_order");
  assert.equal(emailSkipReason(on, { source: "ubereats", order_number: "123" }), "not_crm_order");
});
test("toggle off (or missing) = current behaviour: nothing is ever skipped", () => {
  for (const o of [zuppler, zupplerByEmail, phone, { source: "ezcater", order_number: "X" }]) {
    assert.equal(emailSkipReason(off, o), null);
    assert.equal(emailSkipReason({}, o), null);
  }
});

console.log("\n\"Where it went\" (the CRM orders feed):");
test("a skipped order with no email job reads skipped, with the reason; no skip and no job is still null", () => {
  assert.deepEqual(emailSummary([], "zuppler"), { state: "skipped", job_id: null, sent_at: null, error: null, reason: EMAIL_SKIP_TEXT.zuppler });
  assert.equal(emailSummary([], null), null);
});
test("an email job that exists (sent before the toggle, or by a Resend) is what happened - the skip does not hide it", () => {
  const job = { id: "j1", delivery: "email", status: "printed", sent_at: "2026-11-06T17:00:00Z" } as any;
  assert.equal(emailSummary([job], "zuppler")?.state, "sent");
});
test("the feed asks the rule only where the email leg is in play, and reads the column", () => {
  const crm = src("lib/crm-orders.ts");
  assert.match(crm, /r\.print_method === "email" \? emailSkipReason\(r, o\) : null/);
  assert.match(src("lib/crm-orders-data.ts"), /email_crm_orders_only/);
});

console.log("\ningest, resend, cancellation:");
test("ingest checks the rule before writing an email job, so a skipped order leaves no 'owed' job for health to chase", () => {
  const c = src("lib/canonical.ts");
  const ingest = c.slice(c.indexOf('if (restaurantRow?.print_method === "email")'), c.indexOf("await deliverByEmail({"));
  assert.match(ingest, /emailSkipReason\(restaurantRow, \{ source: input\.source, order_number: input\.orderNumber \}\)/);
  assert.match(ingest, /return;/);
  assert.match(c, /ticket_email_to, email_crm_orders_only/);
});
test("Resend follows the same rule: a skipped order reports skipped (ok, nothing sent), never a failure", () => {
  const r = src("lib/order-resend.ts");
  const fn = r.slice(r.indexOf("async function resendByEmail"), r.indexOf("const admin = supabaseAdmin();", r.indexOf("async function resendByEmail")));
  assert.match(fn, /const skip = emailSkipReason\(r, order\)/);
  assert.match(fn, /ok: true, skipped: true, detail: EMAIL_SKIP_TEXT\[skip\]/);
  assert.match(r, /email_crm_orders_only/);
});
test("an order whose ticket was skipped gets no cancellation email either", () => {
  const c = src("lib/canonical.ts");
  const cancel = c.slice(c.indexOf("export async function sendCancellationEmail"));
  assert.match(cancel, /if \(emailSkipReason\(r, order as any\)\) return;/);
});

console.log("\nthe switch:");
test("migration 057 adds the column, default off, safe to run twice", () => {
  const m = src("db/migrations/057_email_crm_orders_only.sql");
  assert.match(m, /add column if not exists email_crm_orders_only boolean not null default false/);
});
test("the CRM may set it (boolean only) and reads it back on the roster and the write's own response", () => {
  const route = src("app/api/crm/restaurants/[id]/route.ts");
  assert.match(route, /"email_crm_orders_only" in body/);
  assert.match(route, /typeof body\.email_crm_orders_only !== "boolean"/);
  assert.match(route, /ticket_email_to, email_crm_orders_only, app_expected, display_mode/);
  const roster = src("lib/crm-roster.ts");
  assert.match(roster, /email_crm_orders_only: Boolean\(r\.email_crm_orders_only\)/);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
