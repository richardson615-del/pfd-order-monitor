/**
 * "ANOTHER ONE!" (I4, Nick 2026-09-17).
 *
 * The new-order alert is a voice clip; everything else about the alert is
 * unchanged. What has to be true: the alert rule did not move, the clip
 * is the recording we own and small, it is decoded once on arming through
 * the same context, the chooser prefers it and falls back to the chime,
 * it never overlaps itself, and the 0:00 tone stays a plain tone.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { NEW_ORDER_CLIP_URL, newOrderAlertPlan } from "../lib/sound";
import { unaccepted } from "../lib/kiosk";

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
const NOW = Date.parse("2026-09-17T23:30:00Z");

console.log("the clip:");

test("it is in the repo, at the path the code fetches, and under 100 KB", () => {
  assert.equal(NEW_ORDER_CLIP_URL, "/sounds/another-one.mp3");
  const st = statSync(new URL("../public/sounds/another-one.mp3", import.meta.url));
  assert.ok(st.size > 1_000, "not an empty placeholder");
  assert.ok(st.size < 100 * 1024, `${st.size} bytes - a song, not a clip`);
  // And it is an MP3, not something renamed: ID3 tag or a frame sync.
  const head = readFileSync(new URL("../public/sounds/another-one.mp3", import.meta.url)).subarray(0, 3);
  assert.ok(head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), "MP3 header");
});

test("it is served immutable - fetched once per tablet boot", () => {
  const cfg = src("next.config.js");
  assert.match(cfg, /source: "\/sounds\/:path\*"/);
  assert.match(cfg, /public, max-age=31536000, immutable/);
});

console.log("\nthe chooser:");

test("the clip when it is decoded and not still playing; the chime when there is no clip; nothing over itself", () => {
  assert.equal(newOrderAlertPlan({ hasClip: false, clipEndsAt: 0, now: 10 }), "chime");
  assert.equal(newOrderAlertPlan({ hasClip: true, clipEndsAt: 0, now: 10 }), "clip");
  assert.equal(newOrderAlertPlan({ hasClip: true, clipEndsAt: 10.5, now: 10 }), "skip", "still sounding from the last repeat");
  assert.equal(newOrderAlertPlan({ hasClip: true, clipEndsAt: 10, now: 10 }), "clip", "ended exactly now");
});

test("the code follows the plan: one decoded buffer, the same context, the chime as the fallback", () => {
  const s = src("lib/sound.ts");
  assert.match(s, /let clipBuffer: AudioBuffer \| null = null;/);
  assert.match(s, /clipBuffer = await c\.decodeAudioData\(bytes\)/);
  assert.match(s, /void preloadNewOrderClip\(c\);\s*return c\.state === "running";/, "prefetched inside armAudio()");
  const play = s.slice(s.indexOf("export function playNewOrderAlert()"), s.indexOf("export function playOvertimeTone()"));
  assert.match(play, /newOrderAlertPlan\(\{ hasClip: Boolean\(clipBuffer\), clipEndsAt, now: c\.currentTime \}\)/);
  assert.match(play, /if \(plan === "skip"\) return;/);
  assert.match(play, /if \(plan === "chime"\) \{\s*playChime\(\);/);
  assert.match(play, /c\.createBufferSource\(\)/);
  assert.match(play, /clipEndsAt = c\.currentTime \+ clipBuffer!\.duration/);
  assert.match(play, /catch \{[\s\S]*?playChime\(\);/, "a source that will not start falls back too");
  assert.match(s, /export function playChime\(\)/);
  // The context is the one armed by the gesture - no second AudioContext.
  assert.equal((s.match(/new AudioCtx\(\)/g) ?? []).length, 1);
});

console.log("\nwhat did not change:");

test("the alert rule is untouched: unaccepted orders, every 8 s, same ceiling", () => {
  const dash = src("components/OrderDashboard.tsx");
  assert.match(dash, /playNewOrderAlert\(\);\s*soundIntervalRef\.current = setInterval\(playNewOrderAlert, 8000\)/);
  assert.match(dash, /hasNewOrders && soundArmed/);
  assert.match(dash, /const waiting = useMemo\(\(\) => unaccepted\(orders\), \[orders\]\)/);
  const o = { status: "new", accepted_at: null, received_at: new Date(NOW - 60_000).toISOString() };
  assert.equal(unaccepted([o], NOW).length, 1);
  assert.equal(unaccepted([{ ...o, accepted_at: new Date(NOW).toISOString() }], NOW).length, 0);
});

test("the 0:00 tone is a plain tone under its own name, and the dashboard calls that one", () => {
  const s = src("lib/sound.ts");
  const tone = s.slice(s.indexOf("export function playOvertimeTone()"), s.indexOf("export function playChime()"));
  assert.match(tone, /createOscillator\(\)/);
  assert.doesNotMatch(tone, /clipBuffer|createBufferSource/, "never the voice");
  assert.match(src("components/OrderDashboard.tsx"), /if \(crossed\.length && soundArmed\) playOvertimeTone\(\)/);
  assert.doesNotMatch(src("components/OrderDashboard.tsx"), /playAlertBeep|playShortChime/, "the old names are gone, not aliased");
});

console.log(`\n${passed} assertions passed.`);
