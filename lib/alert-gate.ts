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
 * chosen Block, no amount of code can ask again. So "always on" is: never
 * offer a way to skip it, take one tap on first run, keep the subscription
 * alive silently afterwards, and when it has been blocked say so rather than
 * pretending the tablet is fine.
 *
 * ON A MANAGED KIOSK (Nick, 2026-09-16, verified on the trial tablet) the
 * permission is pre-granted by the Hexnode policy - App Permissions ->
 * Premium -> Send push notifications: Allow - so "blocked" means that policy
 * is missing or was changed. A kiosk has no Settings app to open, so the
 * screen must not send anyone there: it says to call Premium, and the
 * heartbeat reports the state (alert_state, migration 037) so the office
 * sees which tablet it is without a phone call.
 *
 * Pure, and separate from the component, for the same reason lib/kiosk.ts is:
 * this decides whether a kitchen finds out it has stopped being alerted.
 */

export type AlertGateState =
  /** Subscribed and permitted. The dashboard is reachable. */
  | "hidden"
  /** Never asked. One tap away - and the tap is the gesture the browser needs. */
  | "ask"
  /** Explicitly denied. Nothing on this screen can undo it; on a kiosk, only the MDM policy can. */
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
  // honest screen is the one that says alerts are off and who can fix it.
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

/**
 * WHY THE GATE KEPT COMING BACK (Workstream AG, Nick, 2026-10-03, Willie
 * Mae's unmanaged Tab A11). Everything below exists because one read on wake
 * was allowed to decide.
 *
 * The check runs on every visibilitychange - screen on, back from another
 * app. It used to read the subscription into a boolean where "the read
 * threw" was null, and then treat null like false; and any failure of the
 * re-record with no subscription in hand put the gate up. So a network blip,
 * a service worker still waking, or a 500 from the route on the first read
 * after the screen came on put a full-screen gate over a tablet whose alerts
 * were fine. To staff that is "it randomly asks again", and they learn to
 * tap through it.
 *
 * Three fixes, all pure so they are tested here rather than on a tablet:
 * the subscription read has three answers, not two (readGate); a failed
 * record never raises the gate (readGate); and a working screen needs two
 * failing reads at least GATE_CONFIRM_MS apart before it raises (settleGate).
 */

/** What the browser's push subscription is, as far as this read could tell. */
export type SubscriptionRead =
  /** The browser holds one (found, or just created). */
  | "present"
  /** Known absent: getSubscription() said none AND a fresh subscribe() failed. Genuinely silent. */
  | "absent"
  /** The read itself threw or timed out. Says nothing about whether a push would arrive. */
  | "unknown";

/**
 * Why the screen cannot ring, or why the office should not trust that it
 * can. Reported on the heartbeat (alert_reason, migration 047) - the CHECK
 * there is this list.
 */
export type AlertReason =
  | "perm_default"
  | "perm_denied"
  | "sub_absent"
  | "sub_read_failed"
  | "record_failed"
  | "unsupported";

export const ALERT_REASONS: readonly AlertReason[] = [
  "perm_default",
  "perm_denied",
  "sub_absent",
  "sub_read_failed",
  "record_failed",
  "unsupported",
];

export interface GateVerdict {
  /** What this one read would show, before settleGate's debounce. */
  state: AlertGateState;
  /** null = nothing wrong. */
  reason: AlertReason | null;
  /** Whether the office may count this screen as ringing: subscribed AND recorded. */
  subscribed: boolean;
}

/**
 * One read's answer.
 *
 * Granted is "hidden" unless the subscription is KNOWN absent. An unknown
 * read and a failed record both stay hidden with `subscribed: false`, so the
 * pill goes amber and the office sees the reason, but the kitchen keeps its
 * orders: neither failure says a push will not arrive, and the next check
 * retries both.
 */
export function readGate(args: {
  supported: boolean;
  permission: NotificationPermission | null;
  subscription: SubscriptionRead;
  /** The POST to /api/push/subscribe succeeded on this read. */
  recorded: boolean;
}): GateVerdict {
  if (!args.supported || args.permission === null) return { state: "unsupported", reason: "unsupported", subscribed: false };
  if (args.permission === "denied") return { state: "blocked", reason: "perm_denied", subscribed: false };
  if (args.permission === "default") return { state: "ask", reason: "perm_default", subscribed: false };
  if (args.subscription === "absent") return { state: "ask", reason: "sub_absent", subscribed: false };
  if (args.subscription === "unknown") return { state: "hidden", reason: "sub_read_failed", subscribed: false };
  if (!args.recorded) return { state: "hidden", reason: "record_failed", subscribed: false };
  return { state: "hidden", reason: null, subscribed: true };
}

/**
 * How long a working screen's failing reads must persist before the gate goes
 * up. Two reads, at least this far apart, both failing, with no good read in
 * between.
 */
export const GATE_CONFIRM_MS = 30_000;

export interface GateMemory {
  /** What the screen is showing now; null before the first read. */
  shown: AlertGateState | null;
  /** When the current run of failing reads began, on a screen still showing hidden. */
  failingSince: number | null;
}

/**
 * The debounce. Decides what the screen shows from what it showed and what
 * this read said.
 *
 * A screen that was not showing the orders (first read, or a gate already up)
 * takes the read as it is: there is nothing working to protect, and making
 * first run wait thirty seconds for its own tap would be its own bug. A
 * screen that WAS showing the orders keeps showing them through a first
 * failing read, and asks for another `recheckInMs` later; the gate goes up
 * only if that one fails too. A good read in between starts the count again.
 */
export function settleGate(
  memory: GateMemory,
  verdict: GateVerdict,
  now: number
): GateMemory & { recheckInMs: number | null } {
  if (verdict.state === "hidden") return { shown: "hidden", failingSince: null, recheckInMs: null };
  if (memory.shown !== "hidden") return { shown: verdict.state, failingSince: null, recheckInMs: null };
  if (memory.failingSince === null) return { shown: "hidden", failingSince: now, recheckInMs: GATE_CONFIRM_MS };
  const waited = now - memory.failingSince;
  if (waited >= GATE_CONFIRM_MS) return { shown: verdict.state, failingSince: null, recheckInMs: null };
  return { shown: "hidden", failingSince: memory.failingSince, recheckInMs: GATE_CONFIRM_MS - waited };
}

/**
 * AG3: an unmanaged tablet whose Premium app is not running on Chrome.
 *
 * The app is a Trusted Web Activity: Android hands it to the default
 * browser, and the notification permission the page sees is delegated from
 * the app only when that browser supports it properly. Chrome does. Samsung
 * Internet - the default on a Samsung tablet nobody has set up - is
 * unreliable at it, and the WebView fallback has no web push at all. Either
 * way the gate loops and nothing at the store explains why, so the gate says
 * the one thing that fixes it.
 *
 * A Hexnode kiosk runs Chrome by policy and never sees this line.
 */
export function browserHostHint(userAgent: string | null | undefined): string | null {
  const ua = userAgent ?? "";
  if (/SamsungBrowser\//.test(ua)) {
    return "This tablet opens Premium in Samsung Internet, which can switch alerts off. In the tablet's settings, choose default apps and set the browser to Chrome, then close Premium and open it again.";
  }
  if (/; wv\)/.test(ua)) {
    return "Premium is running without Chrome, so alerts cannot work. Install or update Chrome from the Play Store, set it as the default browser, then close Premium and open it again.";
  }
  return null;
}
