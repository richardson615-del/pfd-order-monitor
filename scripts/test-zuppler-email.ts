/**
 * Assertions for recognising Zuppler order emails and pulling the order uuid
 * out of them. Network-free: only the pure parts are exercised here.
 */
import assert from "node:assert/strict";
import {
  extractZupplerOrderUuid,
  followableLinks,
  isZupplerOrderEmail,
  safeToFetchLinks,
} from "@/lib/zuppler-email";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

const UUID = "f9212833-f76f-4a7f-a2d4-80d5fc732a41";

async function main() {
  console.log("zuppler email detection:");

  await test("real subject is recognised", () =>
    assert.ok(isZupplerOrderEmail("Attention: Order Updated for Greg Bishop (#2bed4416)")));

  await test("forwarded variant is recognised", () =>
    assert.ok(isZupplerOrderEmail("Fwd: Attention: Order Updated for Mac Baggett (#7c753db5)")));

  await test("PFD's own order email (hex-id subject) is recognised", () =>
    assert.ok(isZupplerOrderEmail(
      "80eb0e25:Delivery order received for marquita clark for Aug 12, 2026 5:25 PM for $71.09",
      '<a href="https://web5.zuppler.com/x">Depot Bar and Grill</a>'
    )));

  await test("forwarded PFD order email is recognised", () =>
    assert.ok(isZupplerOrderEmail(
      "Fwd: 80eb0e25:Delivery order received for marquita clark",
      "<p>restaurant.services@zuppler.com</p>"
    )));

  await test("a hex-id subject with no Zuppler in the body is NOT claimed", () =>
    assert.equal(isZupplerOrderEmail("80eb0e25:Delivery order received", "<p>unrelated</p>"), false));

  await test("a PFD ticket subject is NOT treated as Zuppler", () =>
    assert.equal(isZupplerOrderEmail("Order 1195", "<p>plain</p>"), false));

  await test("unrelated mail is NOT treated as Zuppler", () =>
    assert.equal(isZupplerOrderEmail("Your weekly summary", "<p>hi</p>"), false));

  console.log("link allowlist:");

  await test("only zuppler/sendgrid hosts are followable", () => {
    const html = `
      <a href="https://u14145.ct.sendgrid.net/ls/click?upn=abc">receipt</a>
      <a href="https://web5.zuppler.com/mobile-ordering.html">order</a>
      <a href="https://u.zplr.io/lvltsp00">short</a>
      <a href="https://evil.example.com/steal">bad</a>
      <a href="http://169.254.169.254/latest/meta-data/">metadata</a>
      <a href="file:///etc/passwd">file</a>`;
    const links = followableLinks(html);
    assert.equal(links.length, 3, `expected 3 allowlisted links, got ${links.length}`);
    assert.ok(!links.some((l) => /evil|169\.254|file:/.test(l)), "must not follow untrusted hosts");
  });

  await test("html entities in hrefs are decoded", () => {
    const links = followableLinks('<a href="https://web5.zuppler.com/x?a=1&amp;b=2">l</a>');
    assert.equal(links[0], "https://web5.zuppler.com/x?a=1&b=2");
  });

  console.log("never act on an order:");

  // Zuppler's RESTAURANT notification contains exactly these two buttons.
  // Following either one accepts or rejects a real customer's order.
  const RESTAURANT_NOTIFICATION = `
    <a href="https://u14145.ct.sendgrid.net/ls/click?upn=accept123"><p>Accept Order</p></a>
    <a href="https://u14145.ct.sendgrid.net/ls/click?upn=reject456"><p>Reject Order</p></a>`;

  await test("Accept/Reject links are never fetchable", () =>
    assert.deepEqual(safeToFetchLinks(RESTAURANT_NOTIFICATION), [],
      "following these would accept or reject a live order"));

  await test("a restaurant notification yields no uuid rather than clicking", async () =>
    assert.equal(await extractZupplerOrderUuid(RESTAURANT_NOTIFICATION, { timeoutMs: 1000 }), null));

  await test("a 'View your receipt' link IS fetchable", () =>
    assert.equal(
      safeToFetchLinks('<a href="https://u14145.ct.sendgrid.net/ls/click?upn=x">View your receipt</a>').length,
      1));

  await test("unlabelled links are not followed - allow-list, not deny-list", () =>
    assert.deepEqual(safeToFetchLinks('<a href="https://web5.zuppler.com/x">Click here</a>'), [],
      "an opaque tracking link with no receipt-ish text must not be fetched"));

  await test("action wording beats receipt wording", () =>
    assert.deepEqual(
      safeToFetchLinks('<a href="https://web5.zuppler.com/x">View and accept order</a>'), [],
      "any hint of an action disqualifies the link"));

  await test("an untrusted host is still excluded even when labelled a receipt", () =>
    assert.deepEqual(safeToFetchLinks('<a href="https://evil.example.com/x">View your receipt</a>'), []));

  console.log("uuid extraction:");

  await test("uuid read straight from a receipt link, no network", async () =>
    assert.equal(
      await extractZupplerOrderUuid(`<a href="https://web5.zuppler.com/receipt/${UUID}">x</a>`),
      UUID
    ));

  await test("uuid found in a percent-encoded zru parameter", async () =>
    assert.equal(
      await extractZupplerOrderUuid(
        `<a href="https://web5.zuppler.com/m.html?zru=%2Freceipt%2F${UUID}">x</a>`
      ),
      UUID
    ));

  await test("uppercase uuid is normalised", async () =>
    assert.equal(
      await extractZupplerOrderUuid(`<a href="https://web5.zuppler.com/receipt/${UUID.toUpperCase()}">x</a>`),
      UUID
    ));

  await test("no links, no network calls, returns null", async () =>
    assert.equal(await extractZupplerOrderUuid("<p>nothing here</p>"), null));

  await test("untrusted links are never fetched", async () => {
    // If the allowlist leaked, this would attempt a request; it must not.
    const html = '<a href="https://evil.example.com/receipt/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">x</a>';
    assert.equal(await extractZupplerOrderUuid(html, { timeoutMs: 1000 }), null);
  });

}

main().then(() => {
  console.log(
  process.exitCode
    ? "\nSOME TESTS FAILED"
    : `\nAll assertions passed (${passed} checks).`
);
});
