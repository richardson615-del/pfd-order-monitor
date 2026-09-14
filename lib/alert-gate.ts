/**
 * Whether this tablet is allowed to show the order list yet.
 *
 * Notifications were a button in the corner of the header, and everything
 * about that button was optional: nothing prompted, nothing blocked, errors
 * were swallowed into a console.error, and its own state was local - so it
 * reappeared on every page load whether or not a subscription already
 * existed, and there was no way to tell "never set up" from "set up fine"
 * except by waiting for an order and seeing whether the room heard it.
 *
 * A restaurant that misses orders because a tablet was never subscribed is
 * the most expensive failure this system has, and it looks identical to a
 * quiet evening. So alerts stop being a setting: the dashboard is not
 * reachable until they are on.
 *
 * WHAT "ALWAYS ON" CAN AND CANNOT MEAN. The browser only grants
 * Notification.requestPermission() from a user gesture, and once somebody has
 * chosen Block, no amount of code can ask again - it has to be changed in
 * Android's settings. So "always on" is: never offer a way to skip it, take
 * one tap on first run, keep the subscription alive silently afterwards, and
 * when it has been blocked say exactly how to undo that rather than pretending
 * the tablet is fine. It cannot mean zero taps on a fresh install.
 *
 * Pure, and separate from the component, for the same reason lib/kiosk.ts is:
 * this decides whether a kitchen finds out it has stopped being alerted.
 */

export type AlertGateState =
  /** Subscribed and permitted. The dashboard is reachable. */
  | "hidden"
  /** Never asked. One tap away - and the tap is the gesture the browser needs. */
  | "ask"
  /** Explicitly denied. Only Android's settings can undo this. */
  | "blocked"
  /** No Push API here at all - a desktop browser, or iOS Safari outside the home screen. */
  | "unsupported";

export function alertGateState(args: {
  /** Notification.permission, or null when the API is absent. */
  permission: NotificationPermission | null;
  /**
   * Whether the service worker currently holds a push subscription. `null`
   * means not yet checked - which must NOT open the gate over a screen that
   * is already working while an async read is in flight.
   */
  hasSubscription: boolean | null;
  supported: boolean;
}): AlertGateState {
  if (!args.supported || args.permission === null) return "unsupported";

  // Denied outranks everything. Re-prompting is impossible, so the only
  // honest screen is the one that says how to fix it in Android.
  if (args.permission === "denied") return "blocked";

  if (args.permission === "default") return "ask";

  // Granted. The remaining question is whether a subscription actually
  // exists: permission alone sends nothing. A cleared storage, a reinstalled
  // app or an expired endpoint all land here, and all of them are silent.
  //
  // `null` (not yet read) stays hidden on purpose. Flashing a full-screen
  // gate over a working order list for the half-second it takes to read
  // getSubscription() would train people to tap through it.
  if (args.hasSubscription === false) return "ask";

  return "hidden";
}

/**
 * Whether this state should stop somebody reaching the orders.
 *
 * Every non-hidden state does. There is deliberately no "warn but let them
 * through" - that is what the old header button was, and it is how a tablet
 * ends up running for a month with alerts off.
 */
export const gateBlocks = (state: AlertGateState): boolean => state !== "hidden";
