/**
 * Linking a session-less tablet from the office (Workstream I1.5).
 *
 * These rules decide who gets a session for whose orders, with no
 * credential ever shown on the tablet. Both directions are tested: the
 * device that asked for a code must be able to collect the result, and
 * nothing else - not another device, not a second poll, not a guesser -
 * may.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LINK_CODE_LENGTH,
  LINK_CODE_RATE_MAX,
  LINK_CODE_TTL_MS,
  generateLinkCode,
  isDeviceId,
  isLinkCode,
  linkCodeState,
  mayCollect,
  mayCreateLinkCode,
  tokenHashFrom,
} from "@/lib/link-code";
import { mintDeviceId } from "@/lib/kiosk-cache";

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

const NOW = Date.parse("2026-09-16T18:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

console.log("the code:");

test("six digits, zero-padded, from the bytes it is given", () => {
  assert.equal(generateLinkCode(() => Uint8Array.from([0, 0, 0])), "000000");
  assert.equal(generateLinkCode(() => Uint8Array.from([0, 0, 7])), "000007");
  assert.equal(generateLinkCode(() => Uint8Array.from([0x0f, 0x42, 0x3f])), "999999");
  assert.equal(LINK_CODE_LENGTH, 6);
});

test("a draw above the uniform limit is rejected and redrawn, not folded in", () => {
  // 16 777 216 is not a multiple of a million. The limit is 16 000 000;
  // anything at or above it is thrown away so the low codes are not
  // slightly likelier than the high ones.
  const draws = [Uint8Array.from([0xff, 0xff, 0xff]), Uint8Array.from([0xf4, 0x24, 0x00]), Uint8Array.from([0, 0, 42])];
  let i = 0;
  assert.equal(generateLinkCode(() => draws[i++]), "000042");
  assert.equal(i, 3, "two rejections, then the good draw");
});

test("what counts as a code, and what counts as a device id", () => {
  assert.equal(isLinkCode("123456"), true);
  assert.equal(isLinkCode("12345"), false);
  assert.equal(isLinkCode("1234567"), false);
  assert.equal(isLinkCode("12345a"), false);
  assert.equal(isLinkCode(123456), false);
  assert.equal(isDeviceId(mintDeviceId(() => new Uint8Array(32))), true);
  assert.equal(isDeviceId("short"), false);
  assert.equal(isDeviceId("x".repeat(65)), false);
  assert.equal(isDeviceId("has space here and more chars"), false);
});

test("a device id is 32 symbols from the bytes it is given", () => {
  const id = mintDeviceId((n) => Uint8Array.from({ length: n }, (_, k) => k));
  assert.equal(id.length, 32);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});

console.log("\nits life:");

const row = (over: Record<string, unknown> = {}) => ({
  code: "123456",
  device_id: "device-aaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expires_at: at(LINK_CODE_TTL_MS),
  restaurant_id: null,
  linked_at: null,
  token_hash: null,
  consumed_at: null,
  ...over,
});

test("pending until the office links it, expired thirty minutes on", () => {
  assert.equal(linkCodeState(row(), NOW), "pending");
  assert.equal(linkCodeState(row(), NOW + LINK_CODE_TTL_MS - 1), "pending");
  assert.equal(linkCodeState(row(), NOW + LINK_CODE_TTL_MS), "expired");
  assert.equal(LINK_CODE_TTL_MS, 30 * 60_000);
});

test("linked outlives the thirty minutes - the window is the office's, not the tablet's", () => {
  const linked = row({ linked_at: at(LINK_CODE_TTL_MS - 60_000), token_hash: "h", restaurant_id: "r" });
  assert.equal(linkCodeState(linked, NOW + LINK_CODE_TTL_MS + 60_000), "linked");
});

test("consumed beats everything", () => {
  assert.equal(linkCodeState(row({ linked_at: at(0), consumed_at: at(1) }), NOW), "consumed");
});

test("an unreadable expiry is expired, not pending forever", () =>
  assert.equal(linkCodeState(row({ expires_at: "garbage" }), NOW), "expired"));

console.log("\nwho may collect:");

test("only the device the code was issued to", () => {
  const linked = row({ linked_at: at(0), token_hash: "hash", restaurant_id: "r" });
  assert.equal(mayCollect(linked, linked.device_id, NOW), true);
  assert.equal(mayCollect(linked, "device-bbbbbbbbbbbbbbbbbbbbbbbbbbb", NOW), false);
});

test("not before the office has linked it, and not twice", () => {
  assert.equal(mayCollect(row(), row().device_id, NOW), false, "pending");
  const linked = row({ linked_at: at(0), token_hash: "hash", restaurant_id: "r" });
  assert.equal(mayCollect({ ...linked, consumed_at: at(1) }, linked.device_id, NOW), false, "consumed");
  assert.equal(mayCollect({ ...linked, token_hash: null }, linked.device_id, NOW), false, "linked with nothing to give");
});

test("the status route claims the row in the same statement that reads it", () => {
  // Two polls racing each other must not both be handed the token. The
  // `is null` guard on consumed_at is the whole protection.
  const route = src("app/api/kiosk/link-status/route.ts");
  assert.match(route, /\.update\(\{ consumed_at:[\s\S]*?\.is\("consumed_at", null\)/);
  // A code that exists but is somebody else's is a 404, same as one that
  // does not exist.
  assert.match(route, /!row \|\| row\.device_id !== device[\s\S]*?status: 404/);
  assert.match(route, /"Cache-Control": "no-store"/);
});

console.log("\nwho may create:");

test("twenty in ten minutes from one address is a script, not a kitchen", () => {
  assert.equal(mayCreateLinkCode(0), true);
  assert.equal(mayCreateLinkCode(LINK_CODE_RATE_MAX - 1), true);
  assert.equal(mayCreateLinkCode(LINK_CODE_RATE_MAX), false);
  assert.equal(mayCreateLinkCode(NaN), false);
});

test("a device that still holds a pending code gets the same one back", () => {
  // A code that changed under the office's fingers mid-phone-call is how
  // "read it to me again" becomes the whole call.
  const route = src("app/api/kiosk/link-code/route.ts");
  assert.match(route, /linkCodeState\(existing, now\) === "pending"/);
  assert.match(route, /reply\(existing\.code, existing\.expires_at\)/);
  assert.match(route, /status: 429/);
});

console.log("\nthe office half:");

test("the token is Supabase's hashed magic link, checked before it is stored", () => {
  assert.equal(tokenHashFrom({ properties: { hashed_token: "abc" } }), "abc");
  assert.equal(tokenHashFrom({ properties: { hashed_token: "" } }), null);
  assert.equal(tokenHashFrom({ properties: {} }), null);
  assert.equal(tokenHashFrom(null), null);
  assert.equal(tokenHashFrom("abc"), null);
});

test("the CRM route links only a pending code, once, and never returns the token", () => {
  const route = src("app/api/crm/tablets/link/route.ts");
  assert.match(route, /authorizeCrmWrite\(req\)/);
  assert.match(route, /generateLink\(\{[\s\S]*type: "magiclink"/);
  assert.match(route, /\.is\("linked_at", null\)/, "two office users cannot both link one code");
  assert.match(route, /status: 410/, "expired is named");
  assert.match(route, /code_already_linked/);
  // The response names the restaurant and the login's username. Not the hash.
  const response = route.slice(route.indexOf("return NextResponse.json({\n      ok: true"));
  assert.doesNotMatch(response, /token_hash|tokenHash/);
});

test("the login it binds is the same one provisioning would create", () => {
  // Never a second login, never a reset password. ensureTabletLogin is the
  // one rule for which login a restaurant's tablet uses.
  assert.match(src("app/api/crm/tablets/link/route.ts"), /ensureTabletLogin\(restaurant, actor\)/);
  assert.match(src("lib/provision.ts"), /const ensured = await ensureTabletLogin\(/);
  assert.match(src("lib/provision.ts"), /export async function ensureTabletLogin/);
});

test("the Pairing screen never shows a credential and never links to /login", () => {
  const page = src("app/link/page.tsx");
  assert.match(page, /verifyOtp\(\{[\s\S]*type: "magiclink"/);
  // No input of any kind: nothing is typed on this screen.
  assert.doesNotMatch(page, /<input|<form|href="\/login"/i);
  assert.match(page, /window\.location\.assign\(next\)/, "a full navigation, so the cookies are read");
});

test("a session-less kiosk page goes to /link; only /admin goes to /login", () => {
  const mw = src("middleware.ts");
  assert.match(mw, /path\.startsWith\("\/admin"\) \? "\/login" : "\/link"/);
});

console.log(`\n${passed} assertions passed.`);
