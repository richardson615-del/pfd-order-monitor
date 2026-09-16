/**
 * Past week: seven day tiles and the orders under each.
 *
 * Read-only, counts and totals both (Nick, 2026-09-16: "keep totals").
 * Computed server-side in the restaurant's own day, because the question
 * "how many orders did we do on Wednesday" is about Wednesday in the
 * kitchen, not Wednesday in UTC - and a tile that split the dinner rush
 * across two days would be a tile nobody trusted.
 *
 * Pure: the route fetches, this decides. Tested in a non-UTC zone.
 */
import { Order } from "./types";
import { dayLabel, localDayKey, recentDayKeys } from "./local-day";

export const HISTORY_DAYS = 7;

/** More than this in one day, and the day's list is cut with `truncated`. */
export const HISTORY_DAY_CAP = 500;

export type HistoryOrder = Pick<
  Order,
  | "id"
  | "order_number"
  | "order_type"
  | "customer_name"
  | "customer_total"
  | "status"
  | "source"
  | "received_at"
  | "completed_at"
  | "cancelled_at"
>;

export interface HistoryDay {
  /** "2026-09-16" */
  key: string;
  /** "Today", "Yesterday", "Wed" */
  label: string;
  /** Orders that day, excluding cancelled and test orders. */
  count: number;
  /** Sum of customer_total for the counted orders. */
  total: number;
  /** Newest first. Cancelled and test orders are here, marked, just not counted. */
  orders: HistoryOrder[];
  truncated: boolean;
}

/**
 * Which orders count. A cancelled order is not business done; a test order
 * has no customer. Both are still LISTED under the day, struck through or
 * marked, so the day's list is the day's list - they just do not inflate
 * the tile.
 */
export const countsForHistory = (o: Pick<HistoryOrder, "status" | "source">): boolean =>
  o.status !== "cancelled" && o.source !== "test";

/**
 * The last seven days (oldest first, ending today), each with its orders
 * newest first. `orders` may hold anything received in the window; anything
 * outside the seven day keys is dropped, so the query's own cutoff can be
 * generous.
 */
export function weekHistory(
  orders: HistoryOrder[],
  now: number,
  timezone: string | null | undefined,
  days: number = HISTORY_DAYS
): HistoryDay[] {
  const keys = recentDayKeys(now, timezone, days);
  const byDay = new Map<string, HistoryOrder[]>(keys.map((k) => [k, []]));
  for (const o of orders) {
    const k = localDayKey(o.received_at, timezone);
    byDay.get(k)?.push(o);
  }
  return keys.map((key) => {
    const list = (byDay.get(key) ?? []).sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
    const counted = list.filter(countsForHistory);
    return {
      key,
      label: dayLabel(key, now, timezone),
      count: counted.length,
      total: round2(counted.reduce((sum, o) => sum + (o.customer_total ?? 0), 0)),
      orders: list.slice(0, HISTORY_DAY_CAP),
      truncated: list.length > HISTORY_DAY_CAP,
    };
  });
}

/** The query window: a day of slack either side of seven local days, so DST and zone offsets cannot lose an edge order. */
export const historyWindowStart = (now: number, days: number = HISTORY_DAYS): string =>
  new Date(now - (days + 1) * 24 * 3600_000).toISOString();

const round2 = (n: number) => Math.round(n * 100) / 100;

export const money = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
