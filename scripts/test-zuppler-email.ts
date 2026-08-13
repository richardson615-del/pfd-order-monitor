/**
 * Assertions for recognising Zuppler order emails and pulling the order uuid
 * out of them. Network-free: only the pure parts are exercised here.
 */
import assert from "node:assert/strict";
import {
  extractZupplerOrderUuid,
  followableLinks,
  isZupplerOrderEmail,
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
