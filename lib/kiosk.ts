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
 * How often the dashboard says it is open and signed in.
 *
 * Two minutes against a fifteen-minute staleness threshold, so a browser
 * throttling timers on a backgrounded tab has to miss seven in a row before
 * anybody is told. A heartbeat that cries wolf on ordinary throttling is one
 * people learn to ignore.
 */
export const HEARTBEAT_EVERY_MS = 2 * 60_000;

/** The server refuses a beat sooner than this after the last one (429). Half the cadence: one early beat on a visibility change is fine, a loop is not. */
export const HEARTBEAT_MIN_INTERVAL_MS = 60_000;

/**
 * An order nobody is waiting on any more, so nothing here may sound an alert.
 * A cancelled order in particular must never chime: the whole point of a
 * cancellation is that the food is NOT to be made.
 *
 * Both of these are facts about the ORDER. Note what is deliberately absent:
 * 'printed'. That is a fact about the paper channel, and the paper channel and
 * the tablet are two independent ways for a restaurant to receive an order,
 * not two halves of one. Whether a ticket came out of a printer says nothing
 * about whether the tablet has done its job, and must never be consulted here.
 */
const STILL_WAITING_EXCLUDES = new Set(["completed", "cancelled"]);

/**
 * How long an unopened order still warrants a chime.
 *
 * Six hours - longer than any service, and far longer than any honest
 * response window. Past that nobody is going to cook it, and the alert is
 * demanding an action that no longer exists.
 *
 * This exists because of what happens the first time a tablet is signed in at
 * a restaurant that has been taking orders for months. Every order they ever
 * took is unopened - until that moment there was no tablet to open anything
 * on - so the screen comes up chiming about a backlog going back to whenever
 * they joined, and the only way to silence it is to open every single one.
 * That is exactly what happened on the first real install.
 *
 * A chime nobody can act on is worse than no chime: it is the thing that
 * teaches a kitchen to ignore the noise.
 */
export const STILL_ACTIONABLE_MS = 6 * 60 * 60 * 1000;

/**
 * Orders nobody at the restaurant has ACCEPTED yet.
 *
 * This is what the chime keys off. Accept is a tap on the card or the
 * ticket (Nick, 2026-09-17, I3 - reversing I2's "opening the ticket is
 * the acknowledgement": an order that only offered Done gave the kitchen
 * no way to say "we've got it"). Opening the ticket stamps opened_at for
 * the office's records and stops nothing.
 *
 * It asks only about the tablet: has somebody here accepted this order,
 * is the order still live, and is it recent enough to still be worth
 * acting on. What any other delivery channel did is not an input.
 *
 * Note this governs the CHIME, not the list. An old unaccepted order
 * stays on screen where staff can still see and accept it - it just stops
 * demanding to be dealt with this second.
 */
export function unaccepted<
  T extends { status: string; accepted_at: string | null; received_at?: string | null }
>(orders: T[], now: number = Date.now()): T[] {
  return orders.filter((o) => {
    if (o.accepted_at || STILL_WAITING_EXCLUDES.has(o.status)) return false;

    // No timestamp means we cannot tell how old it is, so chime. A missing
    // field must never be the reason a real order goes unannounced - silence
    // is the failure that costs a restaurant the order.
    if (!o.received_at) return true;

    const age = now - new Date(o.received_at).getTime();
    return Number.isNaN(age) || age < STILL_ACTIONABLE_MS;
  });
}

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
 * Five hundred tablets that all do the same thing at the same moment are a
 * stampede, and the moments they would all pick are the same ones: the
 * second a deploy lands, the second an outage ends. Everything on a timer
 * below is spread a little, and reconnects back off, so the herd arrives
 * over a window instead of as a spike. `rand` is injected so the rules are
 * testable; production passes Math.random.
 */

/** ms spread by ±spread (default 20%): 60 000 → somewhere in 48 000..72 000. */
export function withJitter(ms: number, rand: () => number = Math.random, spread = 0.2): number {
  const r = Math.min(Math.max(rand(), 0), 1);
  return Math.round(ms * (1 - spread + 2 * spread * r));
}

/**
 * The poll, jittered. Same cadence on average; never the same second on
 * two tablets. `liveMs` overrides the healthy cadence: the poll-only feed
 * (lib/order-sync.ts, Realtime off) runs every thirty seconds instead of
 * sixty. The down cadence is the same either way - fifteen seconds, because
 * then this poll is the only way an order can arrive.
 */
export const pollDelayMs = (c: Connection, rand: () => number = Math.random, liveMs: number = POLL_LIVE_MS): number =>
  withJitter(c === "live" ? liveMs : POLL_DOWN_MS, rand);

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/**
 * How long to wait before the Nth reconnect attempt: 1 s, 2 s, 4 s ... capped
 * at a minute, each with full jitter (0..that). After an outage the fleet
 * comes back spread across the minute rather than in one wave that knocks
 * the socket server over again - which is how a five-minute outage becomes
 * a thirty-minute one.
 */
export function reconnectDelayMs(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n);
  const r = Math.min(Math.max(rand(), 0), 1);
  return Math.round(ceiling * r);
}

/**
 * When a tablet is allowed to take a new deployment, beyond "when it is
 * quiet": spread uniformly over ten minutes from the moment it learns of
 * the build. A deploy otherwise reloads every idle tablet inside the same
 * heartbeat window, and five hundred cold page loads at once is a
 * self-inflicted outage on the thing that was just deployed.
 */
export const RELOAD_SPREAD_MS = 10 * 60_000;
export const reloadHoldMs = (rand: () => number = Math.random): number =>
  Math.round(RELOAD_SPREAD_MS * Math.min(Math.max(rand(), 0), 1));

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

/**
 * How long without a successful heartbeat before the screen stops claiming
 * the office can see it. Three misses, matching the reasoning on
 * HEARTBEAT_EVERY_MS: one throttled timer is not an outage.
 */
export const HEARTBEAT_STALE_AFTER_MS = 3 * HEARTBEAT_EVERY_MS;

export type LiveLevel = "live" | "degraded" | "offline";

export interface LiveState {
  level: LiveLevel;
  /** The word on the pill. */
  label: string;
  /** What is wrong and what to do, or null when nothing is. */
  detail: string | null;
}

/**
 * What the status pill is allowed to claim.
 *
 * The pill used to read Supabase Realtime's channel status and nothing else,
 * which meant it said "Live" — in green, all day — on a tablet whose sound
 * was off, whose notifications had never been enabled, and which the office
 * could not see. Every one of those is a tablet that will miss an order, and
 * the screen was reassuring the room about the single thing that happened to
 * be working.
 *
 * So it takes every input that decides whether this tablet will actually
 * raise the alarm, and the word it shows is the worst of them.
 *
 * `null` for pushSubscribed or heartbeatOkAt means NOT YET KNOWN, not
 * missing. On first paint nothing has reported in, and a screen that flashes
 * amber for a second on every load is one nobody reads.
 */
export function liveState(args: {
  connection: Connection;
  stale: boolean;
  soundArmed: boolean;
  pushSubscribed: boolean | null;
  heartbeatOkAt: number | null;
  now: number;
}): LiveState {
  // Orders cannot arrive at all. Nothing else is worth saying.
  if (args.connection === "down" || args.stale) {
    return {
      level: "offline",
      label: "Offline",
      detail: "Not receiving orders — check this tablet's wifi.",
    };
  }

  // Sound first among the degradations, for the same reason kioskWarning puts
  // it first: a connected tablet that cannot chime looks perfectly healthy,
  // and the entire point of the tablet is that somebody notices an order
  // without watching the screen.
  if (!args.soundArmed) {
    return {
      level: "degraded",
      label: "Limited",
      detail: "Sound is off — touch the screen to turn on order alerts.",
    };
  }

  if (args.pushSubscribed === false) {
    return {
      level: "degraded",
      label: "Limited",
      detail: "Alerts are off — this tablet will not ring when it is asleep.",
    };
  }

  if (
    args.heartbeatOkAt !== null &&
    args.now - args.heartbeatOkAt >= HEARTBEAT_STALE_AFTER_MS
  ) {
    return {
      level: "degraded",
      label: "Limited",
      detail: "The office cannot see this tablet — orders are still arriving.",
    };
  }

  if (args.connection === "connecting") {
    return { level: "degraded", label: "Connecting", detail: "Reconnecting…" };
  }

  return { level: "live", label: "Live", detail: null };
}
