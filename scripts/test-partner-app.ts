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
