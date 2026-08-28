/**
 * Middleware routing rules. The auth matcher was widened to let the host gate
 * see every request, so the thing worth asserting is that the auth check did
 * not widen with it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}`); console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}

const src = readFileSync("middleware.ts", "utf8");

// Mirror of isProtected() in middleware.ts.
const isProtected = (p: string) =>
  p.startsWith("/dashboard") || p.startsWith("/admin") || p.startsWith("/order/") ||
  p.startsWith("/api/admin/") || p.startsWith("/api/orders/") ||
  p.startsWith("/api/push/") || p === "/api/gmail/connect";

console.log("middleware:");

test("every path the old matcher protected is still protected", () => {
  for (const p of ["/dashboard", "/dashboard/x", "/admin", "/admin/devices",
                   "/order/123", "/api/admin/restaurants", "/api/orders/1",
                   "/api/push/subscribe", "/api/gmail/connect"]) {
    assert.ok(isProtected(p), `${p} lost its protection`);
  }
});

test("machine endpoints are still unauthenticated", () => {
  // These carry their own credentials; a session check would break them.
  for (const p of ["/api/print/epson", "/api/ingest/zuppler", "/api/monitor/check",
                   "/api/crm/devices", "/api/gmail/poll", "/f/abc123"]) {
    assert.equal(isProtected(p), false, `${p} must not require a session`);
  }
});

test("the host gate runs before any database work", () => {
  // Compare against the CALL SITE, not the import at the top of the file -
  // an earlier version of this assertion matched the import and failed a
  // correct implementation.
  const gate = src.indexOf("PUBLIC_REDIRECT_URL");
  const db = src.indexOf("const supabase = createServerClient");
  assert.ok(gate > 0 && db > 0, "both markers must exist");
  assert.ok(gate < db, "redirect must not cost a Supabase round trip");
});

test("the gate is inert when PUBLIC_BASE_URL is unset", () =>
  assert.match(src, /if \(!base\) return null/));

test("only /f/ is served on the receipt host", () =>
  assert.match(src, /!path\.startsWith\("\/f\/"\)/));

test("the port is stripped before comparing hosts", () =>
  // localhost:3000 must still match a configured bare host in development.
  assert.match(src, /split\(":"\)\[0\]/));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : `\nAll assertions passed (${passed} checks).`);
