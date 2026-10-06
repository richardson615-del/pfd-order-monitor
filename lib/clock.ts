/**
 * The clock in the dashboard header.
 *
 * Pure, so the two decisions worth testing live here: whether a timezone
 * string is one the platform can actually render, and what the clock says
 * when it is not. Both the CRM bridge route (validating a write) and the
 * dashboard (rendering) import from here, so they cannot disagree about
 * what counts as a valid zone.
 */

/**
 * Whether Intl can format in this zone. A bad name throws a RangeError
 * rather than returning a wrong time, which is the property that lets the
 * bridge refuse it with a 400 instead of storing something the tablet would
 * then have to guess about every second.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  // Region/City form only. ICU also accepts legacy abbreviations like "CST",
  // and "CST" is Central Standard Time in Nashville and China Standard Time
  // in Shanghai - an abbreviation is a guess wearing a name.
  if (value !== "UTC" && !value.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every Premium market is on Central time (Nashville, Springfield, south
 * Kentucky), so a restaurant whose zone was never set reads Central rather
 * than whatever the tablet happens to be set to (Matt, 2026-10-06: "the clock
 * needs to be central time"). The CRM still pushes a real zone per
 * restaurant; this is only the default when it has not.
 */
export const DEFAULT_TIMEZONE = "America/Chicago";

/** The restaurant's zone if it is a real one, else Central. */
export function effectiveTimeZone(timezone: string | null | undefined): string {
  return timezone && isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
}

/**
 * 12-hour, always: "8:52 AM", never "08:52" or "20:52". Pinned to en-US
 * because toLocaleTimeString([]) follows the tablet's own language setting,
 * and a tablet set to English (UK) or with 24-hour time on shows a 24-hour
 * clock (Matt, 2026-10-06). Every time a person reads on the tablet goes
 * through these options.
 */
export const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true };

/** "8:52 AM" in the restaurant's zone, Central when it has none. */
export function clockLabel(now: number, timezone: string | null | undefined): string {
  return new Date(now).toLocaleTimeString("en-US", { ...TIME_FORMAT, timeZone: effectiveTimeZone(timezone) });
}
