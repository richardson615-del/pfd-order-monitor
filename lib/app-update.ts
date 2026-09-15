/**
 * When a tablet is allowed to reload itself onto a new deployment.
 *
 * A TWA loads the live site, so every web change is "deployed" to the tablet
 * the moment it ships - except that the page has been open for three weeks
 * and is still running the JavaScript it downloaded then. Nothing reloads a
 * kiosk. That gap has now bitten twice in one day: a Print button that had
 * been rewritten hours earlier still opened the old Android print chooser,
 * and the only fix anyone could give was "swipe the app closed and reopen
 * it", on a device mounted on a wall in a kitchen.
 *
 * THE COST OF RELOADING, which is why this is a decision and not a timer:
 *
 * A reload destroys the AudioContext. Browsers only let one be resumed from
 * a user gesture (see lib/sound.ts), so after an automatic reload the in-page
 * chime is silent until somebody touches the screen. On a kiosk nobody
 * touches, that could be a long time.
 *
 * Two things make that survivable rather than reckless:
 *
 *   1. The push notification is the real alarm and is unaffected - it is an
 *      Android notification, not Web Audio, and C3 made it mandatory. A
 *      tablet with a suspended AudioContext still rings.
 *   2. This only reloads when NOTHING IS WAITING. No unaccepted order means
 *      no chime is being interrupted, nobody is mid-task, and the screen is
 *      not the thing somebody is looking at right now.
 *
 * So a busy restaurant simply updates later, at the next quiet moment, which
 * every restaurant has. Being a version behind for an hour is not the failure
 * worth optimising against; being a version behind until somebody happens to
 * relaunch the app is.
 */

export function updateAvailable(currentBuildId: string, serverBuildId: unknown): boolean {
  // A missing or malformed answer is not an update. Reloading on a bad
  // response would turn one broken deploy into a tablet reload loop.
  if (typeof serverBuildId !== "string" || !serverBuildId) return false;

  // Local development, where both are "dev" and nothing should ever reload.
  if (currentBuildId === "dev" || serverBuildId === "dev") return false;

  return serverBuildId !== currentBuildId;
}

export function shouldReloadNow(args: {
  updateAvailable: boolean;
  /** Unaccepted orders. Anything above zero means somebody is needed. */
  waitingCount: number;
  /** Reloading a tab nobody is looking at achieves nothing and risks a background throttle mid-load. */
  visible: boolean;
}): boolean {
  if (!args.updateAvailable) return false;
  if (args.waitingCount > 0) return false;
  if (!args.visible) return false;
  return true;
}

/** How often to ask. Cheap, and matched to the heartbeat so it is one more request every two minutes, not a new cadence to reason about. */
export const VERSION_CHECK_EVERY_MS = 2 * 60_000;
