/**
 * The Sales tab's period chips (PA6): Today, Yesterday, 7 days, 30 days,
 * This month, Last month. Pure and zone-aware, so "This month" on a
 * Kentucky tablet at 11:30 PM is still this month in Kentucky.
 */
import { localDayKey } from "./local-day";
import type { SalesRange } from "./sales";

export const SALES_PERIODS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" },
] as const;

export type SalesPeriod = (typeof SALES_PERIODS)[number]["key"];

const DAY_MS = 24 * 3600_000;

/** Step a YYYY-MM-DD key by whole days (noon UTC, so no zone or DST can slip it). */
export function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function periodRange(period: SalesPeriod, now: number, timezone: string | null | undefined): SalesRange {
  const today = localDayKey(now, timezone);
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastmonth": {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
  }
}

/** Does the range include today (so the tab keeps itself fresh)? */
export const includesToday = (r: SalesRange, now: number, timezone: string | null | undefined): boolean => {
  const today = localDayKey(now, timezone);
  return r.from <= today && today <= r.to;
};
