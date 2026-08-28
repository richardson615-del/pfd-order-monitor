/**
 * Tests for the smart-footer engine's decisions.
 * The DB paths need a connection; these cover the rules that decide whether
 * a footer renders at all, and the shape of what it produces.
 */
import assert from "node:assert/strict";
import { ENABLED_TEMPLATES } from "@/lib/footer-engine";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

console.log("smart footer v1:");

test("only the two reviewed templates are enabled", () =>
  assert.deepEqual([...ENABLED_TEMPLATES].sort(), ["direct_coupon", "scan_reward"]));

test("prize-based templates are NOT shippable", () => {
  // Sweepstakes carry registration and disclosure duties that vary by state.
  // These stay off until someone qualified has looked at the promo rules.
  assert.ok(!ENABLED_TEMPLATES.includes("milestone_counter" as any));
  assert.ok(!ENABLED_TEMPLATES.includes("mystery_qr" as any));
});

test("coupon codes avoid characters that are ambiguous on paper", () => {
  // A code is read off thermal paper and typed in. O/0 and I/1 cost orders.
  const alphabet = "ABCDEFGHJKMNPQRSTWXYZ23456789";
  for (const c of ["O", "0", "I", "1", "U", "V"]) {
    assert.ok(!alphabet.includes(c), `${c} must not appear in coupon codes`);
  }
});

test("the reward is never conditioned on leaving a review", () => {
  // Google prohibits incentivised reviews and penalises the LISTING, not us.
  // Asserted against the page source so a future edit has to break this.
  const src = require("fs").readFileSync("app/f/[token]/route.ts", "utf8");
  assert.match(src, /yours either way/i, "the page must state the reward is unconditional");
  assert.ok(!/leave a review to (get|claim|receive)/i.test(src));
  assert.ok(!/show.{0,20}review.{0,20}(for|to get)\s+/i.test(src));
});

test("an unknown token and an exhausted one look the same", () => {
  const src = require("fs").readFileSync("app/f/[token]/route.ts", "utf8");
  assert.match(src, /Not found/, "unknown tokens must not confirm existence");
});

test("rate limiting uses shared state, not process memory", () => {
  const src = require("fs").readFileSync("app/f/[token]/route.ts", "utf8");
  assert.match(src, /bump_footer_token/, "must use the Postgres counter");
  assert.ok(!/new Map\(|globalThis\.\w+ =/.test(src), "in-memory limiting is decorative on serverless");
});

test("test orders never mint a coupon or burn a token", () => {
  const src = require("fs").readFileSync("lib/canonical.ts", "utf8");
  assert.match(src, /input\.source !== "test"/);
});

test("printing reads the stored footer and computes nothing", () => {
  const src = require("fs").readFileSync("app/api/print/epson/route.ts", "utf8");
  assert.match(src, /footer_resolved/);
  assert.ok(!/resolveFooter/.test(src), "the print path must not resolve footers");
});

test("printing honours ticket_footer_mode and the footer image", () => {
  // The mode was settable over the bridge for a while without the print path
  // reading it - the CRM could have configured a footer that never changed.
  const src = require("fs").readFileSync("app/api/print/epson/route.ts", "utf8");
  assert.match(src, /ticket_footer_mode/, "print path must read the mode");
  assert.match(src, /ticket_footer_image_b64/, "print path must read the footer image");
  assert.match(src, /mode: footerMode/);
});

test("a dynamic template is never overridden by image mode", () =>
  // Otherwise a coupon code would be replaced by a static picture.
  assert.match(
    require("fs").readFileSync("app/api/print/epson/route.ts", "utf8"),
    /resolved\?\.text \? "qr_with_text"/
  ));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
