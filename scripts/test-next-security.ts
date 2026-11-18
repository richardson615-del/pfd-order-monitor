/**
 * Workstream Z (2026-11-07): pins the two framework-level mitigations.
 *
 * 1. next >= 14.2.35 - fixes the middleware authorization bypass
 *    (GHSA-f82v-jwr5-mffw, `x-middleware-subrequest`) and the Server
 *    Components DoS advisories that have a 14.2.x fix.
 * 2. images.unoptimized = true - Next answers /_next/image with a 404, which
 *    removes the Image Optimization API RCE advisories that have no 14.x fix.
 *    Nothing in app/, components/ or lib/ imports next/image.
 *
 * Z-06 (2026-11-17): raised to next >= 15.5.28 + React 19, which fixes the
 * Server Actions / RSC DoS and SSRF advisories that had no 14.x fix.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

const root = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const spec: string = pkg.dependencies.next;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(spec);
check("next is pinned to an exact version", !!m, spec);
if (m) {
  const [maj, min, patch] = m.slice(1).map(Number);
  const ok = maj > 15 || (maj === 15 && (min > 5 || (min === 5 && patch >= 28)));
  check("next >= 15.5.28 (Server Actions DoS, SSRF, image optimizer RCE fixes; Z-06)", ok, spec);
}

const reactSpec: string = pkg.dependencies.react;
check("react is 19 (Next 15 App Router)", /^\^?19\./.test(reactSpec), reactSpec);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require(join(root, "next.config.js"));
check("images.unoptimized is true (/_next/image returns 404)", config?.images?.unoptimized === true);
// Next 15 names (Z-06): the old experimental keys are ignored with a warning,
// which would silently drop the canvas externalisation and the ticket font.
check("serverExternalPackages keeps @napi-rs/canvas", (config?.serverExternalPackages ?? []).includes("@napi-rs/canvas"));
check("outputFileTracingIncludes traces the ticket font", !!config?.outputFileTracingIncludes?.["/api/print/epson"]);
check("no Next 14 experimental keys left", !config?.experimental?.serverComponentsExternalPackages && !config?.experimental?.outputFileTracingIncludes);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}
const users = ["app", "components", "lib"]
  .flatMap((d) => walk(join(root, d)))
  .filter((f) => /from\s+["']next\/image["']/.test(readFileSync(f, "utf8")));
check("no file imports next/image (unoptimized would change its output)", users.length === 0, users.join(", "));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nnext security: all checks passed");
