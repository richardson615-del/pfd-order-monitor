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
