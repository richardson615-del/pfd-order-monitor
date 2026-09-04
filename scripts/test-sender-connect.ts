/**
 * The sender OAuth grant.
 *
 * A refresh token that can send as info@pfdworks.com is a different kind of
 * credential to a read grant on a restaurant's mailbox, and these assertions
 * exist so the two never quietly merge.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const gmail = readFileSync("lib/gmail.ts", "utf8");
const connect = readFileSync("app/api/gmail/connect-sender/route.ts", "utf8");
const callback = readFileSync("app/api/auth/callback/google/route.ts", "utf8");

console.log("gmail sender grant:");

test("read and send scopes stay separate", () => {
  // Restaurants approve the read scope on their own mailbox. None of them
  // should be granting send-as in the same click.
  assert.match(gmail, /const SCOPES = \["https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly"\]/);
  assert.match(gmail, /SEND_SCOPES = \["https:\/\/www\.googleapis\.com\/auth\/gmail\.send"\]/);
  const readScopes = gmail.match(/const SCOPES = \[[^\]]*\]/)![0];
  assert.ok(!readScopes.includes("gmail.send"), "send must never be in the read grant");
});

test("the sender route is admin-gated", () => {
  assert.match(connect, /isCurrentUserAdmin/);
  assert.match(connect, /status: 401/);
});

test("consent is forced, so a refresh token is always issued", () =>
  // Without prompt=consent Google reissues nothing for an account that has
  // already approved, and the flow silently yields no token.
  assert.match(gmail, /prompt: "consent"/));

test("the token is NEVER put in a redirect URL", () => {
  // A query parameter would land in browser history, the referrer header and
  // every access log in between.
  // Match the VALUE being redirected with, not the word - an earlier version
  // of this assertion tripped on the status string "gmail_sender=no_refresh_token".
  assert.ok(!/redirect\([^)]*tokens\.refresh_token/.test(callback),
    "the token value must never appear in a redirect");
  assert.ok(!/refresh_token=\$\{/.test(callback),
    "no query parameter may carry the token");
  assert.match(callback, /senderTokenPage\(tokens\.refresh_token\)/);
});

test("the token page is not cacheable", () =>
  assert.match(callback, /"Cache-Control": "no-store"/));

test("a sender grant never writes to monitored_inboxes", () => {
  // That table holds restaurants' read tokens; a send credential in it would
  // be indistinguishable from one, and would be handed to the poller.
  const senderBlock = callback.slice(callback.indexOf("if (inboxId === SENDER_STATE)"), callback.indexOf("if (errorParam || !code || !inboxId)"));
  assert.ok(!senderBlock.includes("monitored_inboxes"));
});

test("the page says the token is shown once", () =>
  assert.match(callback, /shown <strong>once<\/strong>/));

test("HTML escaping guards the token page", () =>
  assert.match(callback, /const esc =/));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
