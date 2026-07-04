let ctx: AudioContext | null = null;

/** Plays a short two-tone chime using the Web Audio API. No audio file needed. */
export function playAlertBeep() {
  try {
    if (!ctx) {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;
      ctx = new AudioCtx();
    }
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;
    [880, 1108].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch {
    // Web Audio not available (e.g. very old browser) - fail silently
  }
}
