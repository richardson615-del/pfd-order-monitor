/**
 * SC1 (Z-04, CRM QUEUE row 295, brief prs-crm docs/briefs/2026-11-07-z-bridge-secrets-and-ci.md):
 * no real printer device key (PFD-XXXX-XXXX-XXXX format) in any tracked file.
 *
 * A device key pulls that restaurant's print jobs from /api/print/jobs, and
 * print jobs carry customer names, phones and addresses. Keys live on the
 * machine (print-agent/*.local.plist, gitignored) and in the CRM, never in git.
 *
 * Allowed: the placeholder PFD-XXXX-XXXX-XXXX, and the one made-up test
 * fixture below. A failure names the file and line only, never the key.
 *
 * Run: tsx scripts/test-no-device-keys.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const KEY = /PFD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g;
const ALLOWED = new Set([
  "PFD-XXXX-XXXX-XXXX", // the placeholder in docs, templates and messages
  "PFD-AAAA-BBBB-CCCC", // a made-up key in scripts/test-golive.ts and scripts/test-printer-pairing.ts
]);

/** Every key-shaped string in `text` that is not allowed, as 1-based line numbers. */
export function realKeyLines(text: string): number[] {
  const out: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.match(KEY) ?? []) {
      if (!ALLOWED.has(m)) {
        out.push(i + 1);
        break;
      }
    }
  });
  return out;
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

check("the matcher: placeholder and fixture allowed, any other key-shaped string caught", () => {
  assert.deepEqual(realKeyLines("<string>PFD-XXXX-XXXX-XXXX</string>"), []);
  assert.deepEqual(realKeyLines('device_key: "PFD-AAAA-BBBB-CCCC"'), []);
  // Built from parts, so this file never holds a key-shaped string itself (made up, never a real key).
  const sample = ["PFD", "7Q2M", "K9ZD", "4HWT"].join("-");
  assert.deepEqual(realKeyLines(`ok\n<string>${sample}</string>\n`), [2]);
  assert.deepEqual(realKeyLines(sample.toLowerCase()), []); // lower case is not the format
});

check("no tracked file holds a real device key", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  assert.ok(files.length > 50, `git ls-files returned only ${files.length} files - is this a git checkout?`);
  const hits: string[] = [];
  for (const f of files) {
    if (/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|apk|aab|keystore|jar)$/i.test(f)) continue;
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // deleted in the working tree, or a directory entry
    }
    if (text.includes("\0")) continue; // binary
    for (const line of realKeyLines(text)) hits.push(`${f}:${line}`);
  }
  assert.deepEqual(hits, [], `real-format device key in: ${hits.join(", ")} (replace it with PFD-XXXX-XXXX-XXXX and rotate the key)`);
});

check("the print agent's plist is a template: placeholder key, and *.local.plist is ignored", () => {
  const plist = readFileSync("print-agent/com.pfd.printagent.plist", "utf8");
  assert.match(plist, /<key>PFD_DEVICE_KEY<\/key>\s*<string>PFD-XXXX-XXXX-XXXX<\/string>/);
  assert.match(plist, /never commit a real key/);
  assert.match(readFileSync(".gitignore", "utf8"), /^print-agent\/\*\.local\.plist\r?$/m);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
