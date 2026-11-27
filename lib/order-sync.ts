import type { Connection } from "./kiosk";

/**
 * How a tablet keeps its order list current without holding a websocket.
 *
 * Nick, 2026-09-16 (docs/scale-500.md §6): Supabase Pro caps Realtime at
 * 500 concurrent connections and the plan was to use every one of them.
 * So Realtime is now OPT-IN (NEXT_PUBLIC_REALTIME_ORDERS, default off)
 * and the poll carries the orders. Three things make that acceptable
 * rather than a downgrade:
 *
 *   - The alarm was never the socket. A new order pushes a Web Push
 *     notification (chime + system notification) to the tablet; the
 *     service worker now also tells the open page, which syncs at once.
 *     Latency for a new order is the push's, seconds either way.
 *   - The poll is INCREMENTAL: "orders changed since the last one I
 *     saw" (orders.updated_at, migration 039), which is usually zero
 *     rows - so five hundred tablets polling every thirty seconds is
 *     ~17 tiny PostgREST reads a second, not 500 × 200 rows a minute.
 *     A full pull once an hour (and on load, on return to the
 *     foreground, after a failure) catches anything a cursor could miss.
 *   - The connection pill reads the POLL, not a channel: live after a
 *     successful sync, down after two failures in a row.
 *
 * Pure, like lib/kiosk.ts, so the rules are asserted without a browser.
 */

/** Whether this build holds a Realtime channel per tablet. Off unless the env says so at build time. */
export function realtimeOrdersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.NEXT_PUBLIC_REALTIME_ORDERS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Poll cadence when the poll is the only feed (Realtime off): thirty seconds, jittered by the caller. */
export const POLL_ONLY_MS = 30_000;

/** A full pull at least this often, whatever the cursor says. */
export const FULL_SYNC_EVERY_MS = 60 * 60_000;

/** Failures in a row before the screen stops claiming it can receive orders. One blip is not an outage. */
export const POLL_FAILURES_BEFORE_DOWN = 2;

export type SyncMode = "full" | "incremental";

/** Full when there is no cursor yet, or the last full pull is an hour old; incremental otherwise. */
export function syncPlan(args: { cursor: string | null; lastFullAt: number | null; now: number }): SyncMode {
  if (!args.cursor || args.lastFullAt === null) return "full";
  return args.now - args.lastFullAt >= FULL_SYNC_EVERY_MS ? "full" : "incremental";
}

/**
 * The newest updated_at among what was just read, or the old cursor if
 * nothing newer came. Taken from the ROWS, never from the tablet's clock:
 * a kiosk whose clock drifts a minute fast would otherwise skip every
 * change made in that minute, silently, forever.
 */
export function advanceCursor(cursor: string | null, rows: { updated_at?: string | null }[]): string | null {
  let best = cursor;
  let bestT = best ? Date.parse(best) : -Infinity;
  for (const r of rows) {
    if (!r.updated_at) continue;
    const t = Date.parse(r.updated_at);
    if (Number.isNaN(t)) continue;
    if (t > bestT) {
      best = r.updated_at;
      bestT = t;
    }
  }
  return best;
}

/**
 * Fold changed rows into the list: an id already present is replaced, a
 * new one is added, and the result is newest-received first and capped -
 * the same shape a full pull returns, so the two paths cannot disagree.
 */
export function mergeOrders<T extends { id: string; received_at?: string | null }>(prev: T[], changed: T[], limit = 200): T[] {
  if (!changed.length) return prev;
  const byId = new Map(prev.map((o) => [o.id, o]));
  for (const o of changed) byId.set(o.id, o);
  return [...byId.values()]
    .sort((a, b) => (Date.parse(b.received_at ?? "") || 0) - (Date.parse(a.received_at ?? "") || 0))
    .slice(0, limit);
}

/**
 * What the poll says about the connection when there is no channel to
 * ask. Connecting until the first result; live after a success; down
 * after POLL_FAILURES_BEFORE_DOWN failures in a row.
 */
export function pollConnection(args: { everSucceeded: boolean; failures: number }): Connection {
  if (args.failures >= POLL_FAILURES_BEFORE_DOWN) return "down";
  return args.everSucceeded ? "live" : "connecting";
}

/** The message the service worker posts to open pages when a push lands, so they sync at once. */
export const SW_ORDER_MESSAGE = "premium:order";

/**
 * HP1 (Tickets #1909, #1078, 2026-11-27): what a poll does when it does NOT
 * come back with orders.
 *
 * Read on main before this: the poll asked Supabase straight from the browser
 * and trusted any answer without an error. A browser whose session was gone
 * asks as nobody, the row rules answer "no rows" with a 200, and the screen
 * showed an empty list under a green "Live" - forever, because every later
 * poll got the same polite nothing. A read that never came back had no
 * timeout, and a failure waited out the ordinary cadence before trying again.
 *
 * So: every wait has a limit, a failure is named and retried on a backoff,
 * and an answer is believed only while the browser still holds a session.
 * A session the server confirms is gone sends the screen to sign-in.
 */

/** No single read in a sync may hang longer than this. */
export const SYNC_TIMEOUT_MS = 12_000;

export type SyncFailureKind =
  /** The request never reached anything: wifi off, DNS, captive portal. */
  | "network"
  /** It left and nothing came back inside SYNC_TIMEOUT_MS. */
  | "timeout"
  /** The server answered, with an error. */
  | "server"
  /** The server refused the session's token (401). Refresh, then retry. */
  | "auth";

export interface SyncFailure {
  kind: SyncFailureKind;
  /** The HTTP status, when the server answered with one. */
  status?: number | null;
}

/**
 * Which kind of failure a PostgREST error is. postgrest-js reports a fetch
 * that threw as status 0 with the thrown error's name in the message
 * ("AbortError: ...", "TypeError: Failed to fetch").
 */
export function syncFailureKind(
  err: { status?: number | null; code?: string | null; message?: string | null } | null | undefined,
  online: boolean = true
): SyncFailureKind {
  const status = typeof err?.status === "number" ? err.status : 0;
  const text = `${err?.code ?? ""} ${err?.message ?? ""}`;
  if (status === 401 || /PGRST30[123]|JWT/i.test(text)) return "auth";
  if (/AbortError|ABORT_ERR|timed? ?out/i.test(text)) return "timeout";
  if (!online || status === 0) return "network";
  return "server";
}

/** The sentence the screen shows for a failed sync: what failed, in the kitchen's words. */
export function syncFailureText(failure: SyncFailure | null | undefined): string {
  switch (failure?.kind) {
    case "network":
      return "No internet connection - this screen cannot reach Premium.";
    case "timeout":
      return "The internet here is too slow - Premium did not answer in time.";
    case "auth":
      return "Premium did not accept this screen's sign-in - checking it.";
    case "server":
      return `Premium's order server answered with an error${failure.status ? ` (${failure.status})` : ""}.`;
    default:
      return "This screen could not get the orders.";
  }
}

/** First retry after a failed sync; doubles each time. */
export const SYNC_RETRY_BASE_MS = 3_000;
/** A retry that would wait this long or longer is left to the ordinary poll (15 s while down). */
export const SYNC_RETRY_MAX_MS = 15_000;

/**
 * How long to wait before retrying after the Nth failure in a row: about
 * 3 s, 6 s, 12 s, jittered ±20% so a fleet that lost the same server does
 * not come back in step. null once the wait would reach the ordinary poll's
 * down cadence - from there that poll IS the retry.
 */
export function syncRetryDelayMs(failures: number, rand: () => number = Math.random): number | null {
  const n = Math.floor(failures);
  if (!(n >= 1)) return null;
  const base = SYNC_RETRY_BASE_MS * 2 ** (n - 1);
  if (base >= SYNC_RETRY_MAX_MS) return null;
  const r = Math.min(Math.max(rand(), 0), 1);
  return Math.round(base * (0.8 + 0.4 * r));
}

/** What the browser's own session store says: there is one, there is none, or it could not be read. */
export type SessionRead = "present" | "absent" | "unknown";
/** What the server says about this browser's session (GET /api/dashboard/session). */
export type SessionProbe = "signed_in" | "signed_out" | "unreachable";

export type SessionVerdict =
  /** Read the orders and believe the answer. */
  | "sync"
  /** Ask the server before believing anything. */
  | "probe"
  /** The session is gone. Go to sign-in; never show an empty list. */
  | "sign_in"
  /** Cannot tell. Count it as a failed sync and try again. */
  | "retry";

/**
 * Whether a poll's answer may be believed.
 *
 * Only a session the browser can see makes the read trustworthy. With none,
 * the database answers "no rows" to anybody, so the server is asked first:
 * signed_out sends the screen to sign-in, unreachable is a failed sync.
 * signed_in with no browser session is a browser that cannot read its own
 * cookies; it reads as it always did. A session store that could not be
 * read at all is a failed sync - it never signs a working screen out.
 */
export function sessionVerdict(browser: SessionRead, probe: SessionProbe | null = null): SessionVerdict {
  if (browser === "present") return "sync";
  if (browser === "unknown") return "retry";
  if (probe === null) return "probe";
  if (probe === "signed_out") return "sign_in";
  if (probe === "unreachable") return "retry";
  return "sync";
}

/** HTTP status of the session probe, as a SessionProbe. Only a 401 means signed out. */
export function sessionProbeResult(status: number | null): SessionProbe {
  if (status === 401) return "signed_out";
  if (status !== null && status >= 200 && status < 300) return "signed_in";
  return "unreachable";
}

/**
 * Where a screen with no session goes. The kitchen tablet goes where the
 * middleware already sends it on a reload - /link, which signs a Hexnode
 * kiosk back in by itself and shows a link code on any other tablet. A
 * computer or phone checking in goes to the username form.
 */
export function signInPath(role: "kitchen" | "remote" | null | undefined): string {
  return `${role === "remote" ? "/login" : "/link"}?next=${encodeURIComponent("/dashboard")}`;
}

/**
 * What the Orders tab shows in place of cards.
 *
 * "empty" - the calm "Nothing in the kitchen" - only when the last answer
 * was a real one: a successful read, with a session, and the screen is not
 * offline. Anything else with no cards is "unconfirmed": the screen does
 * not know, and says so instead of looking like a quiet afternoon.
 */
export function ordersListView(args: { count: number; confirmed: boolean; offline: boolean }): "orders" | "empty" | "unconfirmed" {
  if (args.count > 0) return "orders";
  return args.confirmed && !args.offline ? "empty" : "unconfirmed";
}

/** A sync asked for by an event (focus, online) is skipped when one started this recently. */
export const RESYNC_MIN_GAP_MS = 5_000;

export function shouldResync(lastAttemptAt: number | null, now: number, minGapMs: number = RESYNC_MIN_GAP_MS): boolean {
  return lastAttemptAt === null || now - lastAttemptAt >= minGapMs;
}

/**
 * The poll has not even TRIED for this long: its timer chain died or the
 * browser froze it. Three ordinary polls. The dashboard's one-second clock
 * checks this and starts a sync itself.
 */
export const POLL_OVERDUE_MS = 3 * POLL_ONLY_MS;

export function pollOverdue(lastAttemptAt: number | null, now: number, afterMs: number = POLL_OVERDUE_MS): boolean {
  return lastAttemptAt !== null && now - lastAttemptAt >= afterMs;
}

/** Resolve with `fallback` if `p` has not settled within `ms`, or if it rejects. Never rejects. */
export function withTimeout<T, F>(p: PromiseLike<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      () => {
        clearTimeout(id);
        resolve(fallback);
      }
    );
  });
}
