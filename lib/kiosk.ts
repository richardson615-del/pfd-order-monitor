/**
 * Rules for running the dashboard as an unattended kiosk.
 *
 * A tablet on a kitchen wall is a different machine from a phone someone is
 * holding. It boots itself after a power cut, nobody signs into it, nobody
 * looks at an OS notification tray, and the same browser tab stays open for
 * weeks. Every one of those breaks an assumption the dashboard was written
 * with, and each failure is silent in the same way: the screen keeps showing
 * "no new orders", which is indistinguishable from a quiet service.
 *
 * Pure on purpose, like lib/health.ts and for the same reason - these rules
 * decide whether a kitchen finds out it has stopped receiving orders, so they
 * are worth asserting exhaustively without a browser.
 */

export type Connection = "live" | "connecting" | "down";

/**
 * Supabase Realtime's channel status, reduced to what a kitchen needs to know.
 *
 * The distinction that matters is not which error occurred but whether orders
 * can still arrive. A cook cannot act on CHANNEL_ERROR versus TIMED_OUT; they
 * can act on "this screen is not receiving orders right now".
 */
export function realtimeConnection(status: string): Connection {
  switch (status) {
    case "SUBSCRIBED":
      return "live";
    case "CHANNEL_ERROR":
    case "TIMED_OUT":
    case "CLOSED":
      return "down";
    default:
      // Anything unrecognised is treated as not-yet-connected rather than
      // healthy. A new status string in a future client version must not
      // silently read as "live" - failing towards a visible warning is the
      // safe direction when the alternative is a screen that lies.
      return "connecting";
  }
}

/**
 * How often to reconcile against the database directly.
 *
 * This runs whether or not the socket is healthy. Realtime is an optimisation
 * here, not the guarantee: a websocket open for three weeks that quietly died
 * is exactly the failure this exists to survive, and a missed order is worth
 * far more than a query a minute.
 *
 * Faster when the socket is known to be down, because then this poll IS the
 * alert path rather than a backstop for it.
 */
export const POLL_LIVE_MS = 60_000;
export const POLL_DOWN_MS = 15_000;

export const pollIntervalMs = (c: Connection): number =>
  c === "live" ? POLL_LIVE_MS : POLL_DOWN_MS;

/**
 * A screen that has not managed to reach the database for this long is stale,
 * and must say so rather than keep presenting an old list as current.
 *
 * Generously longer than the slow poll: one failed request during a wifi blip
 * is not an outage, and a banner that flickers on every hiccup is one people
 * stop reading.
 */
export const STALE_AFTER_MS = 3 * POLL_LIVE_MS;

export function isStale(
  lastSyncAt: number | null,
  now: number,
  after: number = STALE_AFTER_MS
): boolean {
  if (lastSyncAt === null) return false; // never synced yet - not yet stale
  return now - lastSyncAt >= after;
}

/**
 * What the status strip says. Null means everything is fine and the strip
 * stays out of the way - a permanent banner is furniture, and furniture is
 * not read.
 *
 * Sound comes first when it is off. A screen that is connected but cannot
 * chime is the more dangerous of the two: it looks completely healthy, and
 * the whole point of the tablet is that someone notices an order without
 * watching the screen.
 */
export function kioskWarning(args: {
  connection: Connection;
  soundArmed: boolean;
  stale: boolean;
}): { level: "critical" | "warning"; text: string } | null {
  if (!args.soundArmed) {
    return {
      level: "critical",
      text: "Sound is off — touch the screen to turn on order alerts",
    };
  }
  if (args.connection === "down" || args.stale) {
    return {
      level: "critical",
      text: "Not receiving orders — reconnecting. Check this tablet's wifi.",
    };
  }
  if (args.connection === "connecting") {
    return { level: "warning", text: "Connecting…" };
  }
  return null;
}
