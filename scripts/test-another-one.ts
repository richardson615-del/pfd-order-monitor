/**
 * "ANOTHER ONE!" (I4, Nick 2026-09-17) - and the revert (2026-09-18).
 *
 * After a day in live kitchens the new-order alert went back to the
 * two-tone chime. The clip stays behind NEXT_PUBLIC_NEW_ORDER_ALERT=clip.
 * What has to be true: the chime is the default and the clip is never
 * fetched without the flag; with the flag the chooser prefers the clip,
 * falls back to the chime, and never overlaps itself; the alert rule did
 * not move; the recording is ours and small; the 0:00 tone stays a tone.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { NEW_ORDER_CLIP_URL, newOrderAlertMode, newOrderAlertPlan } from "../lib/sound";
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

test("the chime is the default: no flag, no clip - even with a buffer in hand", () => {
  assert.equal(newOrderAlertMode({}), "chime");
  assert.equal(newOrderAlertMode({ NEXT_PUBLIC_NEW_ORDER_ALERT: "" }), "chime");
  assert.equal(newOrderAlertMode({ NEXT_PUBLIC_NEW_ORDER_ALERT: "voice" }), "chime", "only the one word turns it on");
  assert.equal(newOrderAlertMode({ NEXT_PUBLIC_NEW_ORDER_ALERT: " CLIP " }), "clip");
  assert.equal(newOrderAlertPlan({ mode: "chime", hasClip: true, clipEndsAt: 0, now: 10 }), "chime");
  assert.equal(newOrderAlertPlan({ mode: "chime", hasClip: false, clipEndsAt: 0, now: 10 }), "chime");
});

test("with the flag: the clip when it is decoded and not still playing; the chime when there is no clip; nothing over itself", () => {
  assert.equal(newOrderAlertPlan({ mode: "clip", hasClip: false, clipEndsAt: 0, now: 10 }), "chime");
  assert.equal(newOrderAlertPlan({ mode: "clip", hasClip: true, clipEndsAt: 0, now: 10 }), "clip");
  assert.equal(newOrderAlertPlan({ mode: "clip", hasClip: true, clipEndsAt: 10.5, now: 10 }), "skip", "still sounding from the last repeat");
  assert.equal(newOrderAlertPlan({ mode: "clip", hasClip: true, clipEndsAt: 10, now: 10 }), "clip", "ended exactly now");
});

test("the code follows the plan: one decoded buffer, the same context, the chime as the fallback", () => {
  const s = src("lib/sound.ts");
  assert.match(s, /let clipBuffer: AudioBuffer \| null = null;/);
  assert.match(s, /clipBuffer = await c\.decodeAudioData\(bytes\)/);
  assert.match(s, /if \(newOrderAlertMode\(\) === "clip"\) void preloadNewOrderClip\(c\);\s*return c\.state === "running";/, "prefetched inside armAudio() only with the flag");
  const play = s.slice(s.indexOf("export function playNewOrderAlert()"), s.indexOf("export function playOvertimeTone()"));
  assert.match(play, /if \(mode === "clip" && !clipBuffer\) void preloadNewOrderClip\(c\)/, "never fetched without the flag");
  assert.match(play, /newOrderAlertPlan\(\{ mode, hasClip: Boolean\(clipBuffer\), clipEndsAt, now: c\.currentTime \}\)/);
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
