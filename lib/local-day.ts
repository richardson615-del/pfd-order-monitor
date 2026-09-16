/**
 * "Today", in the restaurant's own day.
 *
 * The Orders list empties at midnight (Nick, 2026-09-16: "every night at
 * midnight"), Completed is "completed today", and Past week is seven day
 * tiles - and every one of those is a question about the RESTAURANT'S
 * calendar, not the server's (UTC) or the tablet's (whatever Android was
 * set to in Nashville). A tablet in eastern Kentucky whose "today" rolled
 * over an hour early would drop the dinner rush's last orders off the
 * screen while the kitchen was still cooking them.
 *
 * Pure, and built on Intl rather than on arithmetic: DST is not a thing to
 * re-implement. `timezone` is restaurants.timezone (migration 032); null
 * falls back to the device's zone, the same way the clock does.
 */

import { isValidTimeZone } from "./clock";

/** "2026-09-16" for the instant, in the zone. */
export function localDayKey(at: string | number | Date, timezone: string | null | undefined): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(timezone && isValidTimeZone(timezone) ? { timeZone: timezone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isSameLocalDay(
  a: string | number | Date | null | undefined,
  b: string | number | Date,
  timezone: string | null | undefined
): boolean {
  if (a === null || a === undefined) return false;
  const ka = localDayKey(a, timezone);
  return ka !== "" && ka === localDayKey(b, timezone);
}

/** "Wed", or "Today" / "Yesterday" for the two the kitchen reads by name. */
export function dayLabel(key: string, now: number, timezone: string | null | undefined): string {
  if (key === localDayKey(now, timezone)) return "Today";
  if (key === localDayKey(now - 24 * 3600_000, timezone) || key === localDayKey(now - 25 * 3600_000, timezone)) return "Yesterday";
  // Noon on that date, so the weekday cannot slip a day on either side of
  // a DST change.
  const noon = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(noon);
}

/**
 * The last `days` local day keys, oldest first, ending today. Built by
 * stepping back a day at a time from now and de-duplicating, so a 23- or
 * 25-hour day (DST) still produces exactly one key per calendar day.
 */
export function recentDayKeys(now: number, timezone: string | null | undefined, days: number): string[] {
  const keys: string[] = [];
  for (let back = 0; keys.length < days && back < days * 2; back++) {
    const k = localDayKey(now - back * 24 * 3600_000, timezone);
    if (k && k !== keys[keys.length - 1]) keys.push(k);
  }
  return keys.reverse();
}

/** "6:29 PM" in the zone (or the device's), for "Done 6:29 PM" and the ticket header. */
export function timeLabel(at: string | number | null | undefined, timezone: string | null | undefined): string {
  if (at === null || at === undefined) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(timezone && isValidTimeZone(timezone) ? { timeZone: timezone } : {}),
  });
}
