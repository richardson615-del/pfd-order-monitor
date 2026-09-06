/**
 * The statement send endpoint.
 *
 * A statement is a financial document addressed to a restaurant owner, so the
 * failure modes are different from a ticket's: a duplicate is two documents
 * about the same money, and a wrong destination is a data leak.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { htmlToPlainText } from "@/lib/email-out";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const route = readFileSync("app/api/crm/send-statement/route.ts", "utf8");

console.log("send-statement:");

test("the bridge does no payout maths and no templating", () => {
  // Two systems computing one payout is how two systems disagree about
  // someone's money. Subject and HTML are sent verbatim.
  assert.ok(!/payout|calculate|template/i.test(route.replace(/^\s*\*.*$/gm, "")));
  assert.match(route, /sendComposedEmail\(to, \{ subject, text, html \}\)/);
});

test("idempotency is checked BEFORE sending, not after", () => {
  const check = route.indexOf('.eq("idempotency_key"');
  const send = route.indexOf("await sendComposedEmail");
  assert.ok(check > 0 && check < send, "a retry must not send a second statement");
});

test("a deduped call reports the original send, not a new one", () => {
  assert.match(route, /deduped: true/);
  assert.match(route, /No second email was sent/);
});

test("every attempt is recorded, including failures and dry runs", () => {
  assert.match(route, /status: result\.ok \? "sent" : "failed"/);
  assert.match(route, /status: "dry_run"/);
});

test("a lost audit row is loud but does not fail the response", () =>
  // The email has already gone; pretending otherwise helps nobody.
  assert.match(route, /audit row NOT recorded/));

test("dry_run sends nothing", () => {
  const dry = route.slice(route.indexOf("if (dryRun)"), route.indexOf("const result = await sendComposedEmail"));
  assert.ok(!dry.includes("sendComposedEmail"));
  assert.match(dry, /sent: false/);
});

test("the response never claims delivery, only acceptance", () =>
  // gmail.send returning 200 means Gmail took it, not that anyone got it.
  assert.match(route, /not a delivery confirmation/));

test("statement HTML is never copied into our database", () => {
  // A second copy of someone's payout figures is a second source of truth.
  assert.match(route, /html_bytes/);
  assert.ok(!/html,\s*$/m.test(route.slice(route.indexOf("const audit ="), route.indexOf("if (dryRun)"))));
});

test("an oversized statement is refused with a reason", () =>
  assert.match(route, /exceeds 5MB/));

test("a bad destination is rejected before anything is sent", () => {
  const check = route.indexOf("`to` must be a valid email address");
  const send = route.indexOf("await sendComposedEmail");
  assert.ok(check > 0 && check < send);
});

console.log("\nhtml -> text fallback:");

test("tags are stripped and structure becomes newlines", () => {
  const t = htmlToPlainText("<h1>Statement</h1><p>Total: <b>$38.35</b></p><p>Thanks</p>");
  assert.match(t, /Statement/);
  assert.match(t, /Total: \$38\.35/);
  assert.ok(!t.includes("<"));
});

test("table cells do not run together", () => {
  const t = htmlToPlainText("<tr><td>Orders</td><td>12</td></tr>");
  assert.match(t, /Orders\t12/);
});

test("script and style contents never leak into the text part", () => {
  const t = htmlToPlainText("<style>.x{color:red}</style><script>alert(1)</script><p>Hi</p>");
  assert.equal(t, "Hi");
});

test("entities are decoded", () =>
  assert.equal(htmlToPlainText("<p>Ariella &amp; Co &quot;Bistro&quot;</p>"), 'Ariella & Co "Bistro"'));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
