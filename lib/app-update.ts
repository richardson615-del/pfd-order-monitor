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

/**
 * How long the screen must have gone untouched before a reload is allowed.
 *
 * "Nothing waiting" says nobody NEEDS the screen. It does not say nobody is
 * USING it: somebody can be reading the Done tab or halfway through a tap.
 * A minute with no finger on the glass is a screen nobody is using.
 */
export const IDLE_BEFORE_RELOAD_MS = 60_000;

export function shouldReloadNow(args: {
  updateAvailable: boolean;
  /** Unaccepted orders. Anything above zero means somebody is needed. */
  waitingCount: number;
  /** Reloading a tab nobody is looking at achieves nothing and risks a background throttle mid-load. */
  visible: boolean;
  /**
   * Milliseconds since the last pointer or key event on the page. `null`
   * means the page has not been measuring, which is treated as "not idle" -
   * a reload must be earned by evidence of quiet, not by the absence of it.
   */
  idleMs: number | null;
}): boolean {
  if (!args.updateAvailable) return false;
  if (args.waitingCount > 0) return false;
  if (!args.visible) return false;
  if (args.idleMs === null || args.idleMs < IDLE_BEFORE_RELOAD_MS) return false;
  return true;
}

/**
 * Which Android shell this page is running inside, if it said.
 *
 * The TWA's startUrl carries `?shell=<appVersionCode>` (android/twa-manifest
 * .json), so the web app can tell the office which shell a tablet has
 * without anyone at the restaurant being asked. The param survives only the
 * first navigation - a login redirect, or any in-app link, drops it - so the
 * page that first sees it remembers it, and every later page reads the
 * memory. Scanned as a substring of the whole (decoded) URL rather than
 * parsed as a query, because the login redirect nests the dashboard URL
 * inside its own `?next=`.
 *
 * `null` means nothing has ever said: a shell from before the param existed,
 * or a plain browser. Not zero - zero would read as "older than everything".
 */
export function readShellVersion(url: string, remembered: string | null | undefined): number | null {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // A malformed escape is not our problem; scan what we were given.
  }
  const m = /[?&]shell=(\d{1,9})(?:\D|$)/.exec(decoded);
  if (m) return Number(m[1]);
  if (remembered && /^\d{1,9}$/.test(remembered)) return Number(remembered);
  return null;
}

/**
 * Whether the office needs to push a newer shell to this tablet.
 *
 * Purely informational on the tablet: the line it produces is amber, not
 * blocking, and asks nothing of the restaurant, because there is nothing a
 * restaurant can do about an APK - the MDM pushes it. An unknown shell is
 * not "too old"; it is unknown, and the heartbeat records it as such.
 */
export function shellNeedsUpdate(shellVersion: number | null, minShellVersion: unknown): boolean {
  const min = typeof minShellVersion === "number" && Number.isFinite(minShellVersion) ? minShellVersion : 0;
  if (shellVersion === null || min <= 0) return false;
  return shellVersion < min;
}

/** localStorage key the shell version is remembered under. */
export const SHELL_VERSION_KEY = "premium.shell";

/**
 * The oldest Android shell (appVersionCode) the office is happy to see on a
 * wall. MIN_SHELL_VERSION in the environment; 0 means no opinion. Server
 * only - the client learns it from the heartbeat or /api/version.
 */
export function minShellVersion(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MIN_SHELL_VERSION ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
