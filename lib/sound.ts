let ctx: AudioContext | null = null;

/**
 * The alert chime, and the reason it has to be armed first.
 *
 * Browsers refuse to make sound from an AudioContext created without a user
 * gesture: it starts `suspended`, and resume() called outside a gesture
 * rejects. This context used to be created lazily inside playAlertBeep(),
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
  return c.state === "running";
}

/**
 * Plays a short two-tone chime. No audio file needed.
 *
 * Does nothing when the context is not running: it cannot fix that itself -
 * only a gesture can - and pretending otherwise is exactly what hid the
 * problem before.
 */
export function playAlertBeep() {
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
