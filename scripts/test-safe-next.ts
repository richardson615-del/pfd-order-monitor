/**
 * Z-07 (row 293, SH2): `next` after sign-in is only ever a path on this site.
 * Pins lib/safe-next.ts and that /login, /link and /auth/callback use it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeNext, DEFAULT_NEXT } from "../lib/safe-next";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

const refused: [string, string | null | undefined][] = [
  ["javascript: URL", "javascript:alert(1)"],
  ["scheme-relative //host", "//evil.example"],
  ["backslash /\\host", "/\\evil.example"],
  ["absolute https URL", "https://evil.example"],
  ["tab that a browser strips to //", "/\t/evil.example"],
  ["newline", "/\n/evil.example"],
  ["data: URL", "data:text/html,hi"],
  ["empty", ""],
  ["null", null],
  ["undefined", undefined],
];
for (const [name, input] of refused) {
  const got = safeNext(input);
  check(`refuses ${name}`, got === DEFAULT_NEXT, JSON.stringify(got));
}

const kept = ["/", "/dashboard", "/orders?tab=today", "/store/hours#busy", "/a//b"];
for (const p of kept) check(`keeps ${p}`, safeNext(p) === p, safeNext(p));
check("fallback can be overridden", safeNext("//x", "/link") === "/link");

const root = join(__dirname, "..");
for (const file of ["app/login/page.tsx", "app/link/page.tsx", "app/auth/callback/route.ts"]) {
  const src = readFileSync(join(root, file), "utf8");
  check(`${file} reads next through safeNext`, /safeNext\(params\.get\("next"\)\)/.test(src));
  check(`${file} has no raw params.get("next") ||`, !/params\.get\("next"\)\s*\|\|/.test(src));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall safe-next checks passed");
