/**
 * Contrast for the CRM palette (Workstream Z, 2026-10-02).
 *
 * The tablet went from dark to the CRM's light set. Light palettes fail in
 * one particular way: a colour that looked loud on near-black turns into a
 * faint word on white - the CRM's amber is about 2:1 as text on a card. This
 * reads the :root tokens straight out of app/globals.css and checks the
 * pairs the screens actually use, so a later token tweak cannot quietly make
 * a late order unreadable across a kitchen.
 *
 * WCAG 2 contrast, computed from oklch with the standard OKLab -> linear sRGB
 * matrices. No dependency.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// The first :root block is the palette (a later one holds nothing but the
// reduced-motion rule).
const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const tokens = new Map<string, string>();
for (const m of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());

type RGB = [number, number, number]; // linear sRGB, 0..1

function resolve(name: string, depth = 0): string {
  const v = tokens.get(name);
  assert.ok(v, `token ${name} is not defined in :root`);
  assert.ok(depth < 10, `token ${name} is a var() loop`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(ref[1], depth + 1) : v;
}

function oklchToLinear(L: number, C: number, h: number): RGB {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function color(name: string): RGB {
  const v = resolve(name);
  const m = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  assert.ok(m, `${name} resolves to "${v}", expected a plain oklch(L C h)`);
  return oklchToLinear(Number(m[1]), Number(m[2]), Number(m[3]));
}

const luminance = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A pill's tinted ground: `color-mix(... X 14%, transparent)` over the card.
// Mixed in gamma-encoded sRGB, which is what the eye sees composited.
const enc = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const dec = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
function tint(fg: RGB, ground: RGB, amount: number): RGB {
  return fg.map((c, i) => dec(enc(c) * amount + enc(ground[i]) * (1 - amount))) as RGB;
}

function atLeast(fg: string, bg: string | RGB, min: number) {
  const ground = typeof bg === "string" ? color(bg) : bg;
  const ratio = contrast(color(fg), ground);
  assert.ok(ratio >= min, `${fg} on ${typeof bg === "string" ? bg : "its tint"} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
}

console.log("text:");

test("body text and dim text read on cards and on the page ground", () => {
  for (const fg of ["--text", "--text-dim"]) for (const bg of ["--panel", "--bg"]) atLeast(fg, bg, 4.5);
});

test("text on the CRM's muted surfaces (tab track, calm countdown) still reads", () => {
  atLeast("--text", "--panel-2", 4.5);
  atLeast("--text-dim", "--panel-2", 4.5);
});

console.log("\nstatus fills:");

test("red and amber fills carry their foreground at 4.5:1 (overdue pill, banners, offline strip)", () => {
  for (const s of ["warning", "critical"]) atLeast(`--status-${s}-foreground`, `--status-${s}`, 4.5);
});

test("the green fill carries white at the large-text 3:1 - and is only used for large labels", () => {
  // The CRM's own green with white is 3.9:1. Kept identical to the CRM on
  // purpose (same green in both apps); every white-on-green label on the
  // tablet is large - Accept 22-26px, Accept/Complete on the ticket 30px,
  // the Ready tick 22px - where WCAG asks 3:1. Small text on green uses
  // the tinted pill (--status-online-text) instead.
  atLeast("--status-online-foreground", "--status-online", 3);
});

test("indigo buttons carry their label at 4.5:1", () => {
  atLeast("--primary-foreground", "--primary", 4.5);
});

test("red and green hold 3:1 against a card, as rails, dots and borders", () => {
  atLeast("--status-critical", "--panel", 3);
  atLeast("--status-online", "--panel", 3);
});

test("amber as a word uses the text amber, which reads at 4.5:1 - the fill amber cannot", () => {
  // The CRM's amber is a FILL colour (about 2:1 on white). Everything that
  // uses amber as text reads --status-warning-text instead; the fill stays
  // for rails and pill grounds, where it sits beside a dark label.
  atLeast("--status-warning-text", "--panel", 4.5);
  atLeast("--status-warning-text", "--bg", 4.5);
  assert.ok(contrast(color("--status-warning"), color("--panel")) < 3, "if the fill amber ever passes, the text amber can go");
});

console.log("\npills (CRM Badge: the colour on its own tint):");

test("red, green and amber pill text reads on its tinted ground", () => {
  const panel = color("--panel");
  atLeast("--status-critical-text", tint(color("--status-critical"), panel, 0.14), 4.5);
  atLeast("--status-online-text", tint(color("--status-online"), panel, 0.14), 4.5);
  atLeast("--status-warning-text", tint(color("--status-warning"), panel, 0.14), 4.5);
});

test("the late part of the summary line and the phone number read on the card", () => {
  atLeast("--age-late", "--panel", 4.5);
  atLeast("--brand", "--panel", 4.5);
});

console.log(`\n${passed} assertions passed.`);
