/**
 * The Store tab (migration 052; prs-crm brief 2026-10-24 §2, A3): the
 * restaurant pauses online orders and changes its hours from the app.
 *
 * Pure. The routes read and write; this decides what a pause and an hours
 * change may be, and the words the CRM and the kitchen read.
 */

export const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export const DAY_LABELS: Record<DayKey, string> = {
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};

export interface TimeRange {
  open: string;
  close: string;
}
export type WeeklyHours = Record<DayKey, TimeRange[]>;

/** Ranges one day may have (lunch + dinner). */
export const MAX_RANGES_PER_DAY = 2;

// --- pause --------------------------------------------------------------------

export const PAUSE_CHOICES = [
  { key: "15", label: "15 minutes", minutes: 15 },
  { key: "30", label: "30 minutes", minutes: 30 },
  { key: "60", label: "1 hour", minutes: 60 },
  { key: "120", label: "2 hours", minutes: 120 },
  { key: "today", label: "Rest of today", minutes: null },
] as const;
export type PauseChoice = (typeof PAUSE_CHOICES)[number]["key"];

/** Pause changes one restaurant may make in ten minutes. */
export const PAUSE_RATE_LIMIT = 8;

export type PauseDecision =
  | { kind: "resume" }
  | { kind: "pause"; until: Date; reason: string | null; label: string }
  | { kind: "error"; error: string };

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Wall-clock parts of `at` in `zone`. Used to find "4 AM tomorrow" in the
 * restaurant's own time without a date library.
 */
function zonedParts(at: Date, zone: string): { y: number; m: number; d: number; h: number; min: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** The instant a given wall-clock time happens in `zone` (good to the minute; DST-safe by one correction pass). */
export function zonedInstant(zone: string, y: number, m: number, d: number, h: number, min: number): Date {
  const want = Date.UTC(y, m - 1, d, h, min);
  // Two passes: the zone's offset is read at the guess, then again at the
  // corrected instant, which is what makes a time just after a DST change right.
  let at = want;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(at), zone);
    at += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  }
  return new Date(at);
}

/**
 * "Rest of today" ends at 4:00 AM the next morning, restaurant time - after
 * any late close, before any breakfast open. Before 4 AM it is 4 AM today.
 */
export function endOfServiceDay(now: Date, zone: string): Date {
  const p = zonedParts(now, zone);
  const today4 = zonedInstant(zone, p.y, p.m, p.d, 4, 0);
  if (now.getTime() < today4.getTime()) return today4;
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + 86_400_000);
  return zonedInstant(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 4, 0);
}

export function clockLabel(at: Date, zone: string): string {
  return at.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
}

export function parsePause(input: unknown, now: Date, zone: string): PauseDecision {
  const o = (input ?? {}) as Record<string, unknown>;
  if (o.resume === true) return { kind: "resume" };
  const choice = PAUSE_CHOICES.find((c) => c.key === o.choice);
  if (!choice) return { kind: "error", error: "Pick how long to pause for." };
  const until = choice.minutes === null ? endOfServiceDay(now, zone) : new Date(now.getTime() + choice.minutes * 60_000);
  return { kind: "pause", until, reason: clean(o.reason, 200), label: choice.label };
}

/** The live pause, or null when none or already over. */
export function livePause(row: { online_paused_until: string | null; online_pause_reason: string | null; online_paused_at: string | null }, now: Date): { until: string; reason: string | null; at: string | null } | null {
  if (!row.online_paused_until) return null;
  if (new Date(row.online_paused_until).getTime() <= now.getTime()) return null;
  return { until: row.online_paused_until, reason: row.online_pause_reason, at: row.online_paused_at };
}

export function pauseMessageBody(d: PauseDecision, zone: string): string {
  if (d.kind === "error") return "";
  if (d.kind === "resume") return "Turned online orders back on.";
  return `Paused online orders for ${d.label.toLowerCase()} (until ${clockLabel(d.until, zone)}).${d.reason ? ` Reason: ${d.reason}` : ""} Please pause us on every ordering site.`;
}

// --- hours --------------------------------------------------------------------

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export type HoursDecision = { kind: "ok"; hours: WeeklyHours; note: string | null } | { kind: "error"; error: string };

/**
 * A week the kitchen typed. Every day must be present; a day is closed
 * ([]) or up to two ranges of "HH:MM". A close earlier than the open means
 * past midnight (a bar open 16:00-02:00). Two ranges may not overlap.
 */
export function parseHoursChange(input: unknown): HoursDecision {
  const o = (input ?? {}) as Record<string, unknown>;
  const raw = (o.hours ?? {}) as Record<string, unknown>;
  const out = {} as WeeklyHours;
  for (const day of DAY_KEYS) {
    const ranges = raw[day];
    if (!Array.isArray(ranges)) return { kind: "error", error: `${DAY_LABELS[day]}: missing` };
    if (ranges.length > MAX_RANGES_PER_DAY) return { kind: "error", error: `${DAY_LABELS[day]}: at most ${MAX_RANGES_PER_DAY} time ranges` };
    const list: TimeRange[] = [];
    for (const r of ranges) {
      const rr = (r ?? {}) as Record<string, unknown>;
      const open = typeof rr.open === "string" ? rr.open : "";
      const close = typeof rr.close === "string" ? rr.close : "";
      if (!HHMM.test(open) || !HHMM.test(close)) return { kind: "error", error: `${DAY_LABELS[day]}: times must be like 11:00 or 21:30` };
      if (open === close) return { kind: "error", error: `${DAY_LABELS[day]}: opening and closing are the same time` };
      list.push({ open, close });
    }
    if (list.length === 2) {
      const [a, b] = [...list].sort((x, y) => toMin(x.open) - toMin(y.open));
      const aClose = toMin(a!.close) <= toMin(a!.open) ? toMin(a!.close) + 1440 : toMin(a!.close);
      if (aClose > toMin(b!.open)) return { kind: "error", error: `${DAY_LABELS[day]}: the two time ranges overlap` };
      list.splice(0, 2, a!, b!);
    }
    out[day] = list;
  }
  if (DAY_KEYS.every((d) => out[d].length === 0)) return { kind: "error", error: "Every day is closed. Use Pause for a short break, or call Premium." };
  return { kind: "ok", hours: out, note: clean(o.note, 300) };
}

/** "11:00" -> "11:00 AM", "21:30" -> "9:30 PM". */
export function time12(t: string): string {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ap}`;
}

export function dayLine(day: DayKey, ranges: TimeRange[]): string {
  return `${DAY_LABELS[day]}: ${ranges.length === 0 ? "Closed" : ranges.map((r) => `${time12(r.open)} - ${time12(r.close)}`).join(", ")}`;
}

/** What a person reads in the CRM thread: only the days that change, or the whole week when there were no hours before. */
export function hoursMessageBody(next: WeeklyHours, current: WeeklyHours | null, note: string | null): string {
  const changed = DAY_KEYS.filter((d) => !current || JSON.stringify(current[d] ?? []) !== JSON.stringify(next[d]));
  const lines = (changed.length ? changed : DAY_KEYS).map((d) => dayLine(d, next[d]));
  return `New hours from the restaurant - ${lines.join("; ")}.${note ? ` Note: ${note}` : ""}`.slice(0, 1000);
}

export function emptyWeek(): WeeklyHours {
  return Object.fromEntries(DAY_KEYS.map((d) => [d, []])) as unknown as WeeklyHours;
}

/** A pushed week, checked; anything malformed is null (shown as "no hours on file"). */
export function readWeek(v: unknown): WeeklyHours | null {
  if (!v || typeof v !== "object") return null;
  const d = parseHoursChange({ hours: v });
  return d.kind === "ok" ? d.hours : null;
}

// --- the CRM's profile push ------------------------------------------------------

export type ProfilePushDecision = { kind: "ok"; hours: WeeklyHours | null; hours_lines: string[]; ordering_channel: "zuppler" | "both" | "pfd" | null } | { kind: "error"; error: string };

export function parseProfilePush(input: unknown): ProfilePushDecision {
  const o = (input ?? {}) as Record<string, unknown>;
  let hours: WeeklyHours | null = null;
  if (o.hours !== null && o.hours !== undefined) {
    // An all-closed week is legal from the CRM (a restaurant closed for the season); only the shape is checked.
    const raw = o.hours as Record<string, unknown>;
    const week = {} as WeeklyHours;
    for (const day of DAY_KEYS) {
      const ranges = raw?.[day];
      if (!Array.isArray(ranges) || ranges.length > 4) return { kind: "error", error: `hours.${day} must be an array` };
      week[day] = [];
      for (const r of ranges) {
        const rr = (r ?? {}) as Record<string, unknown>;
        const open = rr.open === "24:00" ? "23:59" : rr.open;
        const close = rr.close === "24:00" ? "23:59" : rr.close;
        if (typeof open !== "string" || typeof close !== "string" || !HHMM.test(open) || !HHMM.test(close)) return { kind: "error", error: `hours.${day}: bad time` };
        week[day].push({ open, close });
      }
    }
    hours = week;
  }
  const lines = Array.isArray(o.hours_lines) ? (o.hours_lines as unknown[]).map((l) => clean(l, 120)).filter((l): l is string => Boolean(l)).slice(0, 14) : [];
  const ch = o.ordering_channel;
  const ordering_channel = ch === "zuppler" || ch === "both" || ch === "pfd" ? ch : null;
  return { kind: "ok", hours, hours_lines: lines, ordering_channel };
}
