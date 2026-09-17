# Claude Code instruction package — I4: "ANOTHER ONE!" new-order alert (`pfd-order-monitor`)

Author: Nick Davies. Date: 2026-09-17. Obey `README.md`; repo rules win — stop and say so. One PR `feat/another-one-alert`, auto-merge on green. Web-only: no APK.

## Nick's decision (2026-09-17)
The **new-order alert** stops being the synthesized two-tone chime and becomes a voice clip that says **"ANOTHER ONE!"** Everything else about the alert is unchanged: it fires on every unaccepted order, repeats every 8 s until **Accept** (I3), same 6-hour ceiling. The single short tone at the countdown's 0:00 (I3) **stays a plain tone** — that one is a warning, not a celebration.

## Audio file
- Path: `public/sounds/another-one.mp3` (mono, 44.1 kHz, ≤ 1.5 s, normalised to about −1 dBFS so it is as loud as the old chime on a tablet speaker). Keep a `.wav` copy out of the repo.
- **Do not** use any recording of DJ Khaled or any clip pulled from a song, video or meme site — that is a copyrighted sound recording. The phrase itself is fine; the recording must be ours.
- **DONE (2026-09-17, Matt's recording, v4 approved by Nick):** `public/sounds/another-one.mp3` is already in the repo — 0.72 s, mono 44.1 kHz, peaks −1 dBFS, 9 KB, cut and cleaned from the voice memo at `docs/audio/another-one-source.m4a` (natural pitch; noise-reduced, gated, lightly compressed). **Use it as-is; do not generate a TTS placeholder and do not re-encode it.** To regenerate, two passes:
  1. `ffmpeg -i docs/audio/another-one-source.m4a -af "highpass=f=110,lowpass=f=5000,afftdn=nr=45:nf=-45:tn=1:tr=1,anlmdn=s=10:p=0.003:r=0.006,agate=threshold=0.05:ratio=10:attack=2:release=60:range=0.0005:knee=1.5" clean.wav`
  2. `ffmpeg -i clean.wav -ss 1.58 -t 0.72 -af "acompressor=threshold=-16dB:ratio=2.5:attack=4:release=90:makeup=3,equalizer=f=2800:t=q:w=1.2:g=1.5" -ac 1 -ar 44100 stage.wav && ffmpeg -i stage.wav -af "afade=t=in:d=0.015,afade=t=out:st=0.57:d=0.15,alimiter=limit=0.89:level=false" -b:a 96k public/sounds/another-one.mp3`
  (fades must run in a separate pass from the cut — `afade` uses absolute timestamps and silently zeroes the file otherwise.)

## Code (`lib/sound.ts`)
- Keep the AudioContext arming model exactly as it is (see the file's header comment — the first-order-is-silent bug). The clip plays through the **same** context: `fetch('/sounds/another-one.mp3') → arrayBuffer → ctx.decodeAudioData` once, cached in a module-level `AudioBuffer`; `playAlertBeep()` becomes `playNewOrderAlert()` and plays the buffer via `createBufferSource()` when `ctx.state === "running"`. Pre-fetch and decode inside `armAudio()` so the first order isn't delayed by a network round-trip.
- **Fallback:** if the fetch or decode fails (offline, 404, unsupported codec) fall back to the existing two-tone chime — keep that code as `playChime()`. Never silent when the old code would have made a sound.
- New export `playOvertimeTone()` = the single short tone I3 uses at 0:00 — unchanged behaviour, just named so nobody swaps it by accident. Wire I3's 0:00 call to it.
- Guard against overlap: if the previous clip is still playing when the 8 s repeat fires, don't start a second one.
- `next.config` / headers: make sure `/sounds/*` is cached (`Cache-Control: public, max-age=31536000, immutable`) — the file is fetched once per tablet boot.

## Tests (`scripts/test-*.ts`, pure)
- Alert rule unchanged: `unaccepted()` cases still pass untouched.
- A small pure test that the chooser picks the clip when a buffer is present and the chime when it isn't (inject a fake context; no real audio).
- Lint: `public/sounds/another-one.mp3` exists and is under 100 KB (a guard against someone committing a 4 MB song).

## Acceptance (Twisted Fork or Willie Mae's tablet)
- Send a test order → the tablet says "ANOTHER ONE!" and repeats every 8 s until Accept. Accept → silence. Leave an accepted order past 0:00 → one plain tone, not the voice.
- Reboot the tablet, touch nothing, send an order → still speaks (arming + prefetch survived the cold start).

## Decided
Voice clip for new orders only; plain tone at 0:00; ours-not-Khaled's recording; the clip is Matt's recording (v4), already committed. No open questions — build it.
