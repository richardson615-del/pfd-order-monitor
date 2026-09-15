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
 * "8:52 AM" in the restaurant's zone if we know it, else the device's.
 *
 * Falls back rather than failing on purpose: the clock is the least
 * important thing on a screen whose job is to ring, and a header that
 * renders nothing because a zone name was mistyped is worse than one that
 * shows the tablet's own time. The bridge validates on write, so the
 * fallback here is belt and braces, not the plan.
 */
export function clockLabel(now: number, timezone: string | null | undefined): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (timezone && isValidTimeZone(timezone)) {
    return new Date(now).toLocaleTimeString([], { ...opts, timeZone: timezone });
  }
  return new Date(now).toLocaleTimeString([], opts);
}
