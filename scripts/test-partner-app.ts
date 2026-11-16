/**
 * PFD Partner sign-in and push (PA1, migration 054).
 *
 * Worth asserting: what counts as a phone, that codes are uniform and never
 * stored, the code-row rules (expired, used, out of tries), the Bearer
 * parse, the owner-phones list the CRM sends - and, by reading the source,
 * that the routes take the restaurant from the session or the CRM key and
 * never from the request body, and that a code request answers the same
 * whether or not the phone is on file.
 */
import { partnerAppFor } from "@/lib/crm-roster";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_RATE_MAX,
  LOGIN_FAIL_WINDOW_MS,
  LOGIN_FAILS_PER_IP,
  LOGIN_FAILS_PER_USER,
  clientIpFrom,
  overLimit,
  phoneKey,
  bearerToken,
  codeRowState,
  codesMatch,
  hashLoginCode,
  isExpoPushToken,
  isWellFormedCode,
  loginCodeText,
  newLoginCode,
  normalizePhone,
  parseOwnerPhones,
  cleanOwnerName,
} from "@/lib/partner-app";

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
const src = (p: string) => readFileSync(p, "utf8");

console.log("partner app");

test("phones: what people type becomes E.164, anything else is refused", () => {
  for (const v of ["(615) 555-0100", "615.555.0100", "+1 615 555 0100", "16155550100", "6155550100"]) assert.equal(normalizePhone(v), "+16155550100");
  for (const v of ["555-0100", "0155550100", "615555010", "+44 20 7946 0958", "", null, 6155550100]) assert.equal(normalizePhone(v as unknown), null);
});

test("codes: six digits, every value reachable, the hash is not the code and checks constant-time", () => {
  let i = 0;
  const bytes = (seq: number[][]) => () => Uint8Array.from(seq[i++ % seq.length]!);
  assert.equal(newLoginCode(bytes([[0, 0, 7]])), "000007");
  i = 0;
  // 16,000,000 and up is resampled, so 999,999 + 16,000,000 is skipped for the next draw.
  assert.equal(newLoginCode(bytes([[0xf4, 0x24, 0x00], [0, 0, 42]])), "000042");
  const h = hashLoginCode("+16155550100", "123456", "secret");
  assert.ok(!h.includes("123456"));
  assert.ok(codesMatch(h, "+16155550100", "123456", "secret"));
  assert.ok(!codesMatch(h, "+16155550100", "123457", "secret"));
  assert.ok(!codesMatch(h, "+16155550101", "123456", "secret"));
  assert.ok(isWellFormedCode(" 123456 ") && !isWellFormedCode("12345") && !isWellFormedCode(123456));
  assert.match(loginCodeText("123456"), /^123456 is your PFD Partner sign-in code/);
});

test("a code row is spent by use, by tries, or by time", () => {
  const now = Date.parse("2026-10-26T20:00:00Z");
  const fresh = { expires_at: "2026-10-26T20:05:00Z", used_at: null, attempts: 0 };
  assert.equal(codeRowState(fresh, now), null);
  assert.equal(codeRowState({ ...fresh, used_at: "2026-10-26T19:59:00Z" }, now), "used");
  assert.equal(codeRowState({ ...fresh, attempts: LOGIN_CODE_MAX_ATTEMPTS }, now), "too_many_tries");
  assert.equal(codeRowState({ ...fresh, expires_at: "2026-10-26T20:00:00Z" }, now), "expired");
});

test("Bearer header, Expo tokens and owner names", () => {
  assert.equal(bearerToken("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y"), "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer short"), null);
  assert.equal(bearerToken(null), null);
  assert.ok(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"));
  assert.ok(!isExpoPushToken("fcm:abc"));
  assert.equal(cleanOwnerName("  Dana   R  "), "Dana R");
  assert.equal(cleanOwnerName(""), null);
  assert.equal(cleanOwnerName(5), null);
});

test("the CRM's owner-phone list: US numbers, deduplicated, at most ten", () => {
  const ok = parseOwnerPhones({ phones: [{ phone: "615-555-0100", name: "Matt" }, { phone: "+16155550100" }, { phone: "6155550199" }] });
  assert.deepEqual(ok, { ok: true, phones: [{ phone: "+16155550100", name: "Matt" }, { phone: "+16155550199", name: null }] });
  assert.equal(parseOwnerPhones({ phones: [{ phone: "123" }] }).ok, false);
  assert.equal(parseOwnerPhones({ phones: "x" }).ok, false);
  assert.equal(parseOwnerPhones({ phones: Array.from({ length: 11 }, (_, n) => ({ phone: `61555501${String(n).padStart(2, "0")}` })) }).ok, false);
  assert.deepEqual(parseOwnerPhones({ phones: [] }), { ok: true, phones: [] });
});

test("routes take the restaurant from the session or the CRM key, never the body", () => {
  const push = src("app/api/app/push-token/route.ts");
  assert.match(push, /getCurrentUserRestaurantIds\(\)/);
  assert.doesNotMatch(push, /body\.restaurant/);
  const owners = src("app/api/crm/restaurants/[id]/owner-phones/route.ts");
  assert.equal((owners.match(/authorizeCrmWrite\(req\)/g) ?? []).length, 2);
});

test("a code request says the same thing whether or not the phone is on file", () => {
  const lib = src("lib/partner-app-server.ts");
  assert.match(lib, /if \(!owners\.length\) return \{ ok: true \};/);
  // The code is never logged or returned; only the last four digits of a phone are logged.
  assert.doesNotMatch(lib, /console\.[a-z]+\([^)]*[,(]\s*code\s*[,)]/);
  assert.doesNotMatch(src("app/api/app/code/route.ts"), /code:/);
});

test("SH3a (Z-37): a phone is counted as an HMAC, per address too, BEFORE the owner lookup", () => {
  const k = phoneKey("+16155550100", "secret");
  assert.equal(k, phoneKey("+16155550100", "secret"));
  assert.notEqual(k, phoneKey("+16155550101", "secret"));
  assert.notEqual(k, phoneKey("+16155550100", "other"));
  assert.ok(!k.includes("6155550100"));
  const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null });
  assert.equal(clientIpFrom(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIpFrom(h({ "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIpFrom(h({})), "unknown");
  assert.ok(!overLimit(LOGIN_CODE_RATE_MAX - 1, LOGIN_CODE_RATE_MAX) && overLimit(LOGIN_CODE_RATE_MAX, LOGIN_CODE_RATE_MAX));
  const lib = src("lib/partner-app-server.ts");
  const req = lib.slice(lib.indexOf("export async function requestLoginCode"), lib.indexOf("async function sessionForRestaurant"));
  assert.ok(req.indexOf('countAttempts("code_phone"') > 0 && req.indexOf('countAttempts("code_phone"') < req.indexOf("ownerRows(phone)"), "limits are counted before the owner lookup");
  assert.ok(req.indexOf("logAttempts(") < req.indexOf("ownerRows(phone)"), "every request is logged, on file or not");
  assert.match(src("app/api/app/code/route.ts"), /requestLoginCode\(phone, clientIpFrom\(req\.headers\)\)/);
});

test("SH3a (Z-08): a try is claimed atomically before the code is compared; used_at flips once", () => {
  const lib = src("lib/partner-app-server.ts");
  const ver = lib.slice(lib.indexOf("export async function verifyLoginCode"), lib.indexOf("export async function passwordLogin"));
  assert.ok(ver.indexOf('rpc("claim_login_code_try"') > 0 && ver.indexOf('rpc("claim_login_code_try"') < ver.indexOf("codesMatch("), "claim before compare");
  assert.doesNotMatch(ver, /attempts: row\.attempts \+ 1/, "no read-then-write of attempts");
  assert.match(ver, /\.update\(\{ used_at: [^}]+\}\)\.eq\("id", row\.id\)\.is\("used_at", null\)\.select\("id"\)/);
  const sql = src("db/migrations/062_signin_limits.sql");
  assert.match(sql, /attempts < max_tries\s+and used_at is null\s+and expires_at > now\(\)/);
  assert.match(sql, /revoke all on function claim_login_code_try\(uuid, integer\) from public, anon, authenticated/);
  assert.match(sql, /alter table app_signin_attempts enable row level security/);
});

test("SH3a (Z-10): password sign-in pauses after repeated failures, per username and per address", () => {
  assert.equal(LOGIN_FAILS_PER_USER, 5);
  assert.equal(LOGIN_FAIL_WINDOW_MS, 15 * 60_000);
  assert.ok(LOGIN_FAILS_PER_IP > LOGIN_FAILS_PER_USER);
  const lib = src("lib/partner-app-server.ts");
  const pw = lib.slice(lib.indexOf("export async function passwordLogin"), lib.indexOf("export async function refreshAppSession"));
  assert.ok(pw.indexOf("overLimit(") < pw.indexOf("signInWithPassword"), "the limit is checked before Supabase is asked");
  assert.equal((pw.match(/return failed\(\)/g) ?? []).length, 2, "both wrong-password paths log a failure");
  assert.match(pw, /status: 429/);
  assert.match(src("app/api/app/login/route.ts"), /passwordLogin\(username, password, clientIpFrom\(req\.headers\)\)/);
});

test("the server client honours a Bearer token and the push never fails a reply", () => {
  assert.match(src("lib/supabase-server.ts"), /bearerFromRequest\(\)/);
  const reply = src("app/api/crm/messages/route.ts");
  assert.match(reply, /pushToRestaurantApps\(/);
  assert.match(src("lib/partner-push.ts"), /Never throws: a push failing must never fail the order or the reply/);
});

test("the roster counts owner cells and ringing phones per restaurant, never numbers", () => {
  const ctx = { ownerPhoneCount: new Map([["r1", 2]]), appPhones: new Map([["r1", { ios: 1, android: 2, other: 0 }]]) };
  assert.deepEqual(partnerAppFor("r1", ctx), { owner_phones: 2, phones: 3, ios: 1, android: 2 });
  assert.deepEqual(partnerAppFor("r2", ctx), { owner_phones: 0, phones: 0, ios: 0, android: 0 });
  const roster = src("lib/crm-roster.ts");
  assert.match(roster, /from\("app_owner_phones"\)\.select\("restaurant_id"\)/);
  assert.match(roster, /partner_app: partnerAppFor\(r\.id, ctx\)/);
});

console.log(`${passed} passed`);
