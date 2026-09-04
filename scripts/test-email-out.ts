/**
 * The outbound ticket email.
 *
 * The subject is a contract: Automatic Email Manager at the restaurant
 * matches on it to decide what to print. Changing the format silently stops
 * their kitchen printing, which is why it is asserted rather than assumed.
 */
import assert from "node:assert/strict";
import { composeTicketEmail, composeCancellationEmail, buildRawMessage } from "@/lib/email-out";
import { toPlainText, buildTicket } from "@/lib/ticket";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const ORDER: any = {
  order_number: "134d542b", ticket_restaurant_name: "Greek Style Gyro",
  order_type: "pickup", due_time: "2026-09-03T23:00:00Z", received_at: "2026-09-03T22:40:00Z",
  customer_name: "Amber King", customer_phone: "+16156747442",
  items: [
    { name: "Small side of rice", price: "$3.49", modifiers: ["white sauce on top please"] },
    { name: "2x Combo plate", price: "$13.25", modifiers: ["no beef - only chicken & lamb"] },
  ],
  items_total: 30.99, tax: 3.02, service_fee: 4.34, delivery_fee: 0, tip: 0,
  customer_total: 38.35, payment_type: "BRAINTREEINLINE2",
};

console.log("outbound ticket email:");

test("subject starts with PFD ORDER - the AEM rule matches on this", () => {
  const { subject } = composeTicketEmail(ORDER);
  assert.ok(subject.startsWith("PFD ORDER"), `got: ${subject}`);
  assert.match(subject, /#134d542b/);
  assert.match(subject, /PICKUP/);
});

test("a delivery order says DELIVERY", () =>
  assert.match(composeTicketEmail({ ...ORDER, order_type: "delivery" }).subject, /- DELIVERY/));

test("cancellation subject is distinct and unmistakable", () => {
  const { subject, text } = composeCancellationEmail(ORDER);
  assert.equal(subject, "CANCELLED - ORDER #134d542b");
  assert.match(text, /Do not prepare it/);
  // Must NOT match the AEM print rule's prefix, or a cancellation prints as
  // though it were a new order.
  assert.ok(!subject.startsWith("PFD ORDER"));
});

test("no line exceeds the paper width", () => {
  for (const l of composeTicketEmail(ORDER).text.split("\n")) {
    assert.ok(l.length <= 48, `overflow (${l.length}): ${l}`);
  }
});

test("large print is NOT used for email", () => {
  // Double-width lines lay out at 24 columns because the thermal head renders
  // them twice as wide. Plain text cannot, so the ticket would come out
  // ragged - the TOTAL landing mid-line while the subtotal sits at the margin.
  const emailText = composeTicketEmail(ORDER).text;
  const large = toPlainText(buildTicket(ORDER, 48, {}, { scale: "large" }), 48);
  assert.notEqual(emailText, large);
  const totalLine = emailText.split("\n").find(l => l.startsWith("TOTAL"))!;
  assert.equal(totalLine.length, 48, "TOTAL must span the full width");
});

test("modifiers survive - they are what ruins a plate if missed", () => {
  const { text } = composeTicketEmail(ORDER);
  assert.match(text, />> no beef - only chicken & lamb/);
});

test("quantity stays in its own column", () =>
  assert.match(composeTicketEmail(ORDER).text, /^\s+2\s+COMBO PLATE/m));

test("both a plain-text and an HTML part are sent", () => {
  const raw = buildRawMessage("a@b.com", "info@pfdworks.com", composeTicketEmail(ORDER));
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/plain/);
  assert.match(raw, /Content-Type: text\/html/);
});

test("the HTML part is monospace pre - alignment carries the meaning", () => {
  const { html } = composeTicketEmail(ORDER);
  assert.match(html, /<pre/);
  assert.match(html, /monospace/);
});

test("HTML escaping cannot break the markup", () => {
  const { html } = composeTicketEmail({
    ...ORDER, customer_name: 'A <script>alert("x")</script> & co',
  });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("headers use CRLF, as RFC822 requires", () => {
  const raw = buildRawMessage("a@b.com", "info@pfdworks.com", composeTicketEmail(ORDER));
  assert.ok(raw.includes("\r\n"), "bare newlines break some SMTP paths");
});

test("a QR footer degrades to its URL rather than vanishing", () => {
  const { text } = composeTicketEmail(ORDER, { footer: { text: "Thanks!", url: "https://example.com" } });
  assert.match(text, /https:\/\/example\.com/);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
