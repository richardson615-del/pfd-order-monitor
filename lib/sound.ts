let ctx: AudioContext | null = null;

/**
 * The new-order alert is a voice clip - "ANOTHER ONE!" (I4, Nick
 * 2026-09-17; Matt's recording, not anyone else's) - decoded once into
 * this buffer and played through the SAME armed context as everything
 * else. Prefetched inside armAudio() so the first order is not delayed by
 * a network round-trip, and a tablet that comes up after a power cut has
 * it before anyone touches the screen. Null until decoded, and null for
 * good if the fetch or decode fails - the two-tone chime plays instead.
 * Never silent where the old code would have made a sound.
 */
export const NEW_ORDER_CLIP_URL = "/sounds/another-one.mp3";
let clipBuffer: AudioBuffer | null = null;
let clipLoading: Promise<void> | null = null;
/** When the clip currently playing ends (context time); the 8 s repeat must not start a second one over it. */
let clipEndsAt = 0;

async function preloadNewOrderClip(c: AudioContext): Promise<void> {
  if (clipBuffer || clipLoading) return clipLoading ?? Promise.resolve();
  clipLoading = (async () => {
    try {
      const res = await fetch(NEW_ORDER_CLIP_URL, { cache: "force-cache" });
      if (!res.ok) return;
      const bytes = await res.arrayBuffer();
      clipBuffer = await c.decodeAudioData(bytes);
    } catch {
      // Offline, 404 or an unsupported codec: the chime covers it.
    } finally {
      clipLoading = null;
    }
  })();
  return clipLoading;
}

export type NewOrderAlertPlan = "clip" | "chime" | "skip";

/**
 * Which sound a new-order alert makes right now. Pure, so the choice is
 * testable without audio: the clip when it is decoded and not already
 * playing; the chime when there is no clip; nothing when the clip is
 * still sounding from the last repeat (an alert that overlaps itself is
 * noise, and the next repeat is eight seconds away).
 */
export function newOrderAlertPlan(args: { hasClip: boolean; clipEndsAt: number; now: number }): NewOrderAlertPlan {
  if (!args.hasClip) return "chime";
  return args.now < args.clipEndsAt ? "skip" : "clip";
}

/**
 * The alert chime, and the reason it has to be armed first.
 *
 * Browsers refuse to make sound from an AudioContext created without a user
 * gesture: it starts `suspended`, and resume() called outside a gesture
 * rejects. This context used to be created lazily inside the chime function,
 * which meant the very first beep - the one announcing the first order -
 * created a suspended context, scheduled oscillators onto it, and made no
 * sound at all. The screen showed the order and nothing chimed.
 *
 * That is survivable on a phone somebody is holding, because they tapped
 * something to get to the page. It is not survivable on an autostarting
 * kiosk: the tablet comes up after a power cut with nobody having touched it
 * and stays silent until somebody happens to, with nothing anywhere saying
 * so.
 *
 * So arming is explicit, its success is observable, and the dashboard says
 * out loud when sound is off.
 */

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
    return ctx;
  } catch {
    return null;
  }
}

/** True when the context exists and is actually allowed to make sound. */
export function isAudioArmed(): boolean {
  return ctx?.state === "running";
}

/**
 * Creates and resumes the AudioContext. Call from a real user gesture -
 * anywhere on the page will do, which is why the dashboard listens for the
 * first touch rather than asking for a button press nobody would find.
 *
 * Resolves to whether sound will now actually play, so the caller can keep
 * warning if it will not rather than assuming the attempt worked.
 */
export async function armAudio(): Promise<boolean> {
  const c = audioContext();
  if (!c) return false;
  try {
    if (c.state !== "running") await c.resume();
  } catch {
    // Rejected because this was not a genuine user gesture. Not fatal, and
    // not worth logging on every stray event - the caller reports the state.
  }
  // Decode the clip now, whatever the resume did: decodeAudioData needs no
  // gesture, and the first order must not wait on the network.
  void preloadNewOrderClip(c);
  return c.state === "running";
}

/**
 * The new-order alert: "ANOTHER ONE!", or the two-tone chime when the clip
 * is not available. Repeats every 8 s from the dashboard until Accept.
 * Does nothing when the context is not running - it cannot fix that
 * itself, only a gesture can.
 */
export function playNewOrderAlert() {
  const c = audioContext();
  if (!c || c.state !== "running") return;
  if (!clipBuffer) void preloadNewOrderClip(c);
  const plan = newOrderAlertPlan({ hasClip: Boolean(clipBuffer), clipEndsAt, now: c.currentTime });
  if (plan === "skip") return;
  if (plan === "chime") {
    playChime();
    return;
  }
  try {
    const source = c.createBufferSource();
    source.buffer = clipBuffer;
    source.connect(c.destination);
    source.start();
    clipEndsAt = c.currentTime + clipBuffer!.duration;
  } catch {
    // A source that would not start is the chime's job.
    playChime();
  }
}

/**
 * One short single tone: the countdown just hit zero (I3). Once per order,
 * never repeating, and deliberately a plain tone - the voice is for a new
 * order; this is a warning, not a celebration - so nobody swaps it.
 */
export function playOvertimeTone() {
  const c = audioContext();
  if (!c || c.state !== "running") return;
  try {
    const now = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.32);
  } catch {
    // Web Audio not available - fail silently, same as the chime.
  }
}

/**
 * The two-tone chime. No audio file needed - which is why it is the
 * fallback when the clip could not be fetched or decoded.
 *
 * Does nothing when the context is not running: it cannot fix that itself -
 * only a gesture can - and pretending otherwise is exactly what hid the
 * problem before.
 */
export function playChime() {
  const c = audioContext();
  if (!c || c.state !== "running") return;

  try {
    const now = c.currentTime;
    [880, 1108].forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch {
    // Web Audio not available (e.g. very old browser) - fail silently
  }
}
