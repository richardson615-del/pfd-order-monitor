/**
 * Owner login emails (lib/owner-invite.ts, /api/crm/restaurants/:id/owner-invite,
 * /set-password). The things that must not regress: a link is never spent by
 * opening it, the caller never gets the link or a password back, and a
 * derived tablet address is never mailed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composeOwnerLoginEmail,
  isAlreadyRegistered,
  parseOwnerEmail,
  parseSetPasswordParams,
  setPasswordUrl,
} from "@/lib/owner-invite";

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
const route = src("app/api/crm/restaurants/[id]/owner-invite/route.ts");
const page = src("app/set-password/page.tsx");
const middleware = src("middleware.ts");

console.log("owner invite");

test("a real address is accepted and lowercased", () => {
  assert.deepEqual(parseOwnerEmail("  Owner@Example.COM "), { email: "owner@example.com" });
});

test("a derived tablet address is refused", () => {
  const r = parseOwnerEmail("swezeys@tablet.pfdworks.com");
  assert.ok("error" in r && /tablet login/.test(r.error));
});

test("junk is refused", () => {
  assert.ok("error" in parseOwnerEmail("not-an-email"));
  assert.ok("error" in parseOwnerEmail(undefined));
});

test("already-registered wording is recognised", () => {
  assert.ok(isAlreadyRegistered("A user with this email address has already been registered"));
  assert.ok(!isAlreadyRegistered("rate limit exceeded"));
});

test("the link puts the token in the query, never a fragment", () => {
  const url = setPasswordUrl("https://pfd-order-monitor.vercel.app", "abcdef0123456789abcdef", "invite");
  assert.equal(url, "https://pfd-order-monitor.vercel.app/set-password?token_hash=abcdef0123456789abcdef&type=invite");
  assert.ok(!url.includes("#"));
});

test("set-password reads back only invite or recovery with a sane token", () => {
  const p = (q: string) => parseSetPasswordParams(new URLSearchParams(q));
  assert.deepEqual(p("token_hash=abcdef0123456789abcdef&type=recovery"), {
    tokenHash: "abcdef0123456789abcdef",
    type: "recovery",
  });
  assert.equal(p("token_hash=abcdef0123456789abcdef&type=magiclink"), null);
  assert.equal(p("token_hash=short&type=invite"), null);
  assert.equal(p("type=invite"), null);
});

test("the email has the button link, the sign-in page and the address", () => {
  const e = composeOwnerLoginEmail({
    restaurantName: "Firecrackers Pizza <Joelton>",
    link: "https://x.test/set-password?token_hash=t&type=invite",
    loginUrl: "https://x.test/login",
    email: "owner@example.com",
    type: "invite",
  });
  assert.match(e.subject, /Your Premium login for Firecrackers Pizza <Joelton>/);
  assert.ok(e.html.includes("Firecrackers Pizza &lt;Joelton&gt;"), "restaurant name is escaped in HTML");
  assert.ok(e.html.includes('href="https://x.test/set-password?token_hash=t&amp;type=invite"'));
  assert.ok(e.text.includes("https://x.test/login") && e.text.includes("owner@example.com"));
});

test("a recovery email says new password, not new login", () => {
  const e = composeOwnerLoginEmail({ restaurantName: "X", link: "l", loginUrl: "u", email: "a@b.co", type: "recovery" });
  assert.match(e.subject, /new password/);
});

test("the route is CRM-key only and links the owner role", () => {
  assert.ok(route.includes("authorizeCrmWrite(req)"));
  assert.ok(route.includes('role: "owner"'));
  assert.ok(route.includes("ignoreDuplicates: true"), "an existing link keeps its role");
});

test("the route never returns the link or a password", () => {
  const responses = route.match(/NextResponse\.json\([\s\S]*?\)\s*;/g) ?? [];
  assert.ok(responses.length > 0);
  for (const r of responses) {
    assert.ok(!/hashed_token|action_link|password/.test(r), `response leaks: ${r.slice(0, 120)}`);
  }
});

test("the route sends the hashed token, not the self-consuming action_link", () => {
  assert.ok(route.includes("properties.hashed_token"));
  assert.ok(!route.includes("action_link"));
});

test("sending a link drops any stored copy of the password", () => {
  assert.ok(route.includes("password_current: null"));
  assert.ok(route.indexOf("password_current: null") < route.indexOf("sendComposedEmail(email"));
});

test("an admin's address is refused", () => {
  assert.ok(route.includes('.from("admins")'));
});

test("preview changes nothing", () => {
  const start = route.indexOf("body.preview === true");
  const end = route.indexOf("const admin = supabaseAdmin()");
  const branch = route.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/generateLink|sendComposedEmail|upsert|insert/.test(branch));
});

test("opening /set-password spends nothing; the button does", () => {
  const submitAt = page.indexOf("async function submit");
  const verifyAt = page.indexOf("auth.verifyOtp");
  assert.ok(submitAt > 0 && verifyAt > submitAt, "verifyOtp only inside submit");
  assert.ok(!page.includes("useEffect"), "nothing runs on load");
});

test("/set-password needs no session", () => {
  assert.ok(!/startsWith\("\/set-password"\)/.test(middleware));
});

console.log(`\n${passed} passed`);
