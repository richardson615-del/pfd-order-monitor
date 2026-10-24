/**
 * Which screen this is: the kitchen tablet, or somebody checking in from a
 * computer or a phone with the same login (partner portal A2, 2026-10-24;
 * Matt: "they should be able to use same login online to see on computer",
 * then "make mobile friendly too").
 *
 * It matters for two things, and only two:
 *
 *   - The alert gate. A kitchen tablet that cannot ring is broken, so the
 *     gate blocks it until alerts are on. An owner opening the app on a
 *     laptop to look at last week's money is not broken; blocking them with
 *     "Turn on order alerts" (or, on an iPhone, "Open this in the Premium
 *     app") just locks them out.
 *   - The heartbeat. There is one heartbeat row per restaurant, and it is the
 *     office's proof that the KITCHEN is watching. A laptop's beat would
 *     overwrite the tablet's - and keep a dead tablet looking alive.
 *
 * Kitchen is the safe default. A screen is remote only when nothing says it
 * is a tablet (no Android shell, no device reference) AND it looks like a
 * computer (a mouse) or a phone (a small screen). A tablet in plain Chrome
 * has neither, so it stays a kitchen screen. Anyone can flip it either way
 * from the screen itself; the choice is remembered on that browser.
 *
 * Pure, like lib/kiosk.ts: these rules decide whether the office can tell a
 * kitchen has stopped watching for orders.
 */

export type ScreenRole = "kitchen" | "remote";

export const SCREEN_ROLE_KEY = "pfd-screen-role";

/** Below this, the screen's SHORT side is a phone's. Tablets start around 600 CSS px. */
export const PHONE_MAX_SHORT_SIDE = 600;

export interface ScreenFacts {
  /** The Android shell's version (?shell=), or null outside the shell. */
  shellVersion: number | null;
  /** The device reference the shell handed over (?device=), or null. */
  deviceRef: string | null;
  /** matchMedia("(pointer: fine)") - a mouse or trackpad. */
  pointerFine: boolean;
  /** min(screen.width, screen.height) in CSS px. */
  shortSide: number;
  /** What a person on this browser chose, if they did. */
  chosen: string | null;
}

export function screenRole(f: ScreenFacts): ScreenRole {
  if (f.chosen === "kitchen" || f.chosen === "remote") return f.chosen;
  if (f.shellVersion !== null || f.deviceRef) return "kitchen";
  if (f.pointerFine) return "remote";
  if (f.shortSide > 0 && f.shortSide < PHONE_MAX_SHORT_SIDE) return "remote";
  return "kitchen";
}
