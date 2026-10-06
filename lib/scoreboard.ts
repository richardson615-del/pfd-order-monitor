/**
 * The Stats tab: how the kitchen is doing, as a game it can win.
 *
 * Matt, 2026-10-06: "lets add some gamification analytics to the app".
 * Everything here is derived from columns the orders table already has -
 * received_at, accepted_at, status, source, customer_total - so there is no
 * new table, no migration and nothing to keep in step. A restaurant that
 * never looks at the tab loses nothing; one that does gets a reason to hit
 * Accept faster, which is the one behaviour this app exists to produce.
 *
 * What it scores, and why each one:
 *   - accept speed: the gap between an order landing and somebody tapping
 *     Accept. It is the whole point of the alert, and it is the number the
 *     office already chases restaurants about.
 *   - the streak: orders in a row accepted inside FAST_ACCEPT_SECONDS.
 *     One slow order breaks it. Easy to understand from across a kitchen.
 *   - the daily goal: beat this weekday's recent average, so a quiet Tuesday
 *     is not judged against a Friday rush.
 *   - points and levels: a running month total so a good week shows up even
 *     on a slow day.
 *   - badges: a handful of plain achievements, each with the rule written on
 *     it, so nobody has to guess how to earn one.
 *
 * Pure: the route reads the rows, this decides. Computed in the
 * restaurant's own day (lib/local-day.ts), same as Past week. Tested in a
 * non-UTC zone (scripts/test-scoreboard.ts).
 */
import { localDayKey, recentDayKeys, dayLabel } from "./local-day";
import type { Order } from "./types";

export type ScoreOrder = Pick<Order, "received_at" | "accepted_at" | "status" | "source" | "customer_total">;

/** "Fast" means accepted inside two minutes. The office's own bar. */
export const FAST_ACCEPT_SECONDS = 120;
/** Under a minute earns the bigger bonus. */
export const LIGHTNING_ACCEPT_SECONDS = 60;
/** An accept time past this is a tablet that was off, not a slow cook; it is not averaged. */
export const ACCEPT_OUTLIER_SECONDS = 3 * 3600;
/** How far back the route reads: the month so far plus a buffer for the weekday average. */
export const SCOREBOARD_DAYS = 36;

export const POINTS_PER_ORDER = 10;
export const POINTS_LIGHTNING = 5;
export const POINTS_FAST = 3;
export const POINTS_PER_LEVEL = 1000;

/** Kitchen ranks, lowest first. The last one repeats with a number. */
export const LEVEL_NAMES = ["Rookie", "Line Cook", "Grill Master", "Sous Chef", "Head Chef", "Pitmaster", "Legend"] as const;

export interface Badge {
  key: string;
  label: string;
  /** The rule, in words, shown under the badge. */
  rule: string;
  earned: boolean;
  /** 0..1 toward earning it; 1 when earned. */
  progress: number;
  /** "7 / 10" */
  progressLabel: string;
}

export interface ScoreDay {
  key: string;
  label: string;
  count: number;
}

export interface Scoreboard {
  today: {
    orders: number;
    sales: number;
    accepted: number;
    /** Median accept time in seconds, or null with nothing accepted today. */
    typicalAcceptSeconds: number | null;
    fastestAcceptSeconds: number | null;
    /** Share of today's accepted orders taken inside FAST_ACCEPT_SECONDS, 0..1, or null. */
    fastShare: number | null;
  };
  goal: {
    target: number;
    done: number;
    /** "Beat your usual Tuesday (12)" or "Starter goal" when there is no history yet. */
    basis: string;
  };
  streak: {
    /** Orders in a row, newest first, accepted fast. */
    current: number;
    /** Best run in the window. */
    best: number;
  };
  points: {
    today: number;
    month: number;
    level: number;
    levelName: string;
    /** Points into the current level, and the size of a level. */
    intoLevel: number;
    perLevel: number;
  };
  /** Last 7 days, oldest first, with the same weekday a week earlier for comparison. */
  week: (ScoreDay & { lastWeek: number })[];
  badges: Badge[];
}

/** Same rule as Past week: cancelled and test orders are not business done. */
export const countsForScore = (o: Pick<ScoreOrder, "status" | "source">): boolean =>
  o.status !== "cancelled" && o.source !== "test";

/** Seconds from arrival to Accept, or null when it was never accepted or the gap is not believable. */
export function acceptSeconds(o: Pick<ScoreOrder, "received_at" | "accepted_at">): number | null {
  if (!o.accepted_at) return null;
  const a = Date.parse(o.accepted_at);
  const r = Date.parse(o.received_at);
  if (Number.isNaN(a) || Number.isNaN(r)) return null;
  const s = Math.max(0, Math.round((a - r) / 1000));
  return s > ACCEPT_OUTLIER_SECONDS ? null : s;
}

export function pointsFor(o: ScoreOrder): number {
  if (!countsForScore(o)) return 0;
  const s = acceptSeconds(o);
  let p = POINTS_PER_ORDER;
  if (s !== null && s <= LIGHTNING_ACCEPT_SECONDS) p += POINTS_LIGHTNING;
  else if (s !== null && s <= FAST_ACCEPT_SECONDS) p += POINTS_FAST;
  return p;
}

export function levelOf(points: number): { level: number; levelName: string; intoLevel: number } {
  const level = Math.floor(Math.max(0, points) / POINTS_PER_LEVEL) + 1;
  const last = LEVEL_NAMES.length - 1;
  const levelName = level - 1 <= last ? LEVEL_NAMES[level - 1] : `${LEVEL_NAMES[last]} ${level - last}`;
  return { level, levelName, intoLevel: Math.max(0, points) % POINTS_PER_LEVEL };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Orders in a row accepted fast, walking newest to oldest. An order that was
 * never accepted, or was accepted slowly, ends a run; cancelled and test
 * orders are skipped (they are not the kitchen's to score). An order still
 * waiting right now does not break the current streak until it is either
 * accepted or past the fast window - a run should not drop the moment a
 * new ticket lands.
 */
export function streaks(orders: ScoreOrder[], now: number): { current: number; best: number } {
  const counted = orders
    .filter(countsForScore)
    .sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
  let current = 0;
  let best = 0;
  let run = 0;
  let currentOpen = true;
  for (const o of counted) {
    const s = acceptSeconds(o);
    const stillInWindow = !o.accepted_at && now - Date.parse(o.received_at) <= FAST_ACCEPT_SECONDS * 1000;
    if (stillInWindow) continue;
    const fast = s !== null && s <= FAST_ACCEPT_SECONDS;
    if (fast) {
      run++;
      if (currentOpen) current = run;
    } else {
      currentOpen = false;
      run = 0;
    }
    best = Math.max(best, run);
  }
  return { current, best: Math.max(best, current) };
}

const pct = (n: number, d: number) => (d > 0 ? n / d : 0);

export function buildScoreboard(orders: ScoreOrder[], now: number, timezone: string | null | undefined): Scoreboard {
  const todayKey = localDayKey(now, timezone);
  const monthPrefix = todayKey.slice(0, 7);

  const byDay = new Map<string, ScoreOrder[]>();
  for (const o of orders) {
    if (!countsForScore(o)) continue;
    const k = localDayKey(o.received_at, timezone);
    if (!k) continue;
    const list = byDay.get(k);
    if (list) list.push(o);
    else byDay.set(k, [o]);
  }
  const countOn = (k: string) => byDay.get(k)?.length ?? 0;

  // --- today
  const todays = byDay.get(todayKey) ?? [];
  const acceptTimes = todays.map(acceptSeconds).filter((s): s is number => s !== null);
  const fastToday = acceptTimes.filter((s) => s <= FAST_ACCEPT_SECONDS).length;
  const today = {
    orders: todays.length,
    sales: Math.round(todays.reduce((sum, o) => sum + (o.customer_total ?? 0), 0) * 100) / 100,
    accepted: acceptTimes.length,
    typicalAcceptSeconds: median(acceptTimes),
    fastestAcceptSeconds: acceptTimes.length ? Math.min(...acceptTimes) : null,
    fastShare: acceptTimes.length ? fastToday / acceptTimes.length : null,
  };

  // --- the last 35 day keys, oldest first; today is the last
  const keys35 = recentDayKeys(now, timezone, 35);
  // Same weekday in each of the last four weeks: 7, 14, 21, 28 days back.
  const sameWeekday = [7, 14, 21, 28]
    .map((back) => keys35[keys35.length - 1 - back])
    .filter((k): k is string => !!k);
  const withOrders = sameWeekday.map(countOn).filter((n) => n > 0);
  const usual = withOrders.length ? Math.round(withOrders.reduce((a, b) => a + b, 0) / withOrders.length) : 0;
  const weekdayName = weekdayOf(todayKey);
  const goal = usual > 0
    ? { target: usual + 1, done: today.orders, basis: `Beat your usual ${weekdayName} (${usual})` }
    : { target: 10, done: today.orders, basis: "Starter goal" };

  // --- week bars
  const keys14 = keys35.slice(-14);
  const week = keys14.slice(-7).map((key, i) => ({
    key,
    label: dayLabel(key, now, timezone),
    count: countOn(key),
    lastWeek: countOn(keys14[i]),
  }));

  // --- points
  const monthOrders = [...byDay.entries()].filter(([k]) => k.startsWith(monthPrefix)).flatMap(([, v]) => v);
  const monthPoints = monthOrders.reduce((sum, o) => sum + pointsFor(o), 0);
  const todayPoints = todays.reduce((sum, o) => sum + pointsFor(o), 0);
  const lvl = levelOf(monthPoints);

  const streak = streaks(orders, now);

  // --- badges: each one's rule is the text on it
  const lastWeekSameDay = countOn(keys35[keys35.length - 8] ?? "");
  const monthCount = monthOrders.length;
  const typical = today.typicalAcceptSeconds;
  const badges: Badge[] = [
    {
      key: "lightning",
      label: "Lightning",
      rule: "10 orders in a row accepted under 2 minutes",
      earned: streak.best >= 10,
      progress: Math.min(1, streak.best / 10),
      progressLabel: `${Math.min(streak.best, 10)} / 10`,
    },
    {
      key: "perfect-shift",
      label: "Perfect shift",
      rule: "5+ orders today, every one accepted under 2 minutes",
      earned: today.orders >= 5 && today.accepted === today.orders && fastToday === today.orders,
      progress: today.orders >= 5 ? pct(fastToday, today.orders) : Math.min(1, fastToday / 5),
      progressLabel: `${fastToday} / ${Math.max(5, today.orders)}`,
    },
    {
      key: "beat-last-week",
      label: "Beat last week",
      rule: `More orders than last ${weekdayName} (${lastWeekSameDay})`,
      earned: today.orders > lastWeekSameDay && today.orders > 0,
      progress: lastWeekSameDay > 0 ? Math.min(1, today.orders / (lastWeekSameDay + 1)) : today.orders > 0 ? 1 : 0,
      progressLabel: `${today.orders} / ${lastWeekSameDay + 1}`,
    },
    {
      key: "fast-hands",
      label: "Fast hands",
      rule: "Typical accept under 1 minute today (3+ orders)",
      earned: typical !== null && typical <= LIGHTNING_ACCEPT_SECONDS && today.accepted >= 3,
      progress: today.accepted >= 3 && typical !== null ? Math.min(1, LIGHTNING_ACCEPT_SECONDS / Math.max(typical, 1)) : Math.min(1, today.accepted / 3),
      progressLabel: typical === null ? "No accepts yet" : `${formatSeconds(typical)} typical`,
    },
    {
      key: "century",
      label: "Century",
      rule: "100 orders this month",
      earned: monthCount >= 100,
      progress: Math.min(1, monthCount / 100),
      progressLabel: `${Math.min(monthCount, 100)} / 100`,
    },
  ];

  return {
    today,
    goal,
    streak,
    points: { today: todayPoints, month: monthPoints, level: lvl.level, levelName: lvl.levelName, intoLevel: lvl.intoLevel, perLevel: POINTS_PER_LEVEL },
    week,
    badges,
  };
}

/** "Tuesday" for "2026-10-06". Noon UTC so the weekday cannot slip across a DST edge. */
export function weekdayOf(key: string): string {
  const noon = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(noon.getTime())) return "day";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(noon);
}

/** "42s", "1:05", "12:30". */
export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Query window start: SCOREBOARD_DAYS back plus a day of slack for zone offsets. */
export const scoreboardWindowStart = (now: number): string =>
  new Date(now - (SCOREBOARD_DAYS + 1) * 24 * 3600_000).toISOString();
