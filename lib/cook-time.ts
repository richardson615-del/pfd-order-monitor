import { MAX_PREP_MINUTES, MIN_PREP_MINUTES, isValidPrepMinutes } from "./countdown";
import { READY_MINUTE_CHOICES } from "./ready-timer";
import { DAY_KEYS, clockLabel, zonedInstant, zonedParts, type TimeRange } from "./store";

/**
 * Busy-time cook time (BT1, prs-crm QUEUE row 241, Ticket #948; migration 058).
 *
 * "A safe, limited way for restaurant to adjust timers with guardrails and an
 * audit log." The kitchen adds minutes for a busy spell; Accept pre-selects
 * default + boost until it ends on its own. The limits live here and the routes
 * enforce them, so a request that skips the screen is refused the same way.
 *
 * Pure, and safe in the browser: the routes, the tablet and the tests share it.
 */

export interface CookLimits {
  max_boost_minutes: number;
  max_length_minutes: number;
  band_min: number;
  band_max: number;
}

/** Brief defaults: boost at most +30 min, for at most 2 h; the kitchen's own default stays within 10-45. */
export const DEFAULT_COOK_LIMITS: CookLimits = { max_boost_minutes: 30, max_length_minutes: 120, band_min: 10, band_max: 45 };

/** The busy buttons. */
export const BOOST_CHOICES: readonly number[] = [10, 15, 20, 30];
export const BOOST_LENGTH_CHOICES: readonly number[] = [30, 60, 120];

/** The furthest the CRM can move a limit; the migration's CHECK matches. */
export const LIMIT_RANGES: Record<keyof CookLimits, { min: number; max: number }> = {
  max_boost_minutes: { min: 1, max: 120 },
  max_length_minutes: { min: 1, max: 720 },
  band_min: { min: MIN_PREP_MINUTES, max: MAX_PREP_MINUTES },
  band_max: { min: MIN_PREP_MINUTES, max: MAX_PREP_MINUTES },
};

export const COOK_LIMIT_SELECT = "cook_max_boost_minutes, cook_max_busy_minutes, cook_band_min, cook_band_max";
export const BUSY_SELECT = "busy_boost_minutes, busy_started_at, busy_until, busy_started_by";

export interface CookLimitColumns {
  cook_max_boost_minutes?: number | null;
  cook_max_busy_minutes?: number | null;
  cook_band_min?: number | null;
  cook_band_max?: number | null;
}

/** A restaurant's limits: its overrides over the defaults. */
export function cookLimitsOf(r: CookLimitColumns | null | undefined): CookLimits {
  return {
    max_boost_minutes: r?.cook_max_boost_minutes ?? DEFAULT_COOK_LIMITS.max_boost_minutes,
    max_length_minutes: r?.cook_max_busy_minutes ?? DEFAULT_COOK_LIMITS.max_length_minutes,
    band_min: r?.cook_band_min ?? DEFAULT_COOK_LIMITS.band_min,
    band_max: r?.cook_band_max ?? DEFAULT_COOK_LIMITS.band_max,
  };
}

const sorted = (values: Iterable<number>): number[] => [...new Set(values)].sort((a, b) => a - b);

/** The picks that fit under a limit, plus the limit itself when dispatch set one that is not a button. */
const upTo = (choices: readonly number[], max: number): number[] => sorted([...choices.filter((c) => c <= max), max]);

export const boostChoices = (l: CookLimits): number[] => upTo(BOOST_CHOICES, l.max_boost_minutes);
export const boostLengthChoices = (l: CookLimits): number[] => upTo(BOOST_LENGTH_CHOICES, l.max_length_minutes);

/** Default cook times the kitchen may pick: the Accept quick picks inside its band, plus the band's own ends. */
export function cookTimeChoices(l: CookLimits): number[] {
  return sorted([...READY_MINUTE_CHOICES.filter((m) => m >= l.band_min && m <= l.band_max), l.band_min, l.band_max]);
}

export const ASK_DISPATCH = "Ask dispatch to change it.";

/** What the kitchen may store as its own default cook time. Whole minutes outside the band are refused with who to ask. */
export function parseKitchenCookTime(input: unknown, limits: CookLimits = DEFAULT_COOK_LIMITS): { kind: "ok"; minutes: number } | { kind: "error"; code: string; error: string } {
  const m = ((input ?? {}) as Record<string, unknown>).prep_minutes;
  if (isValidPrepMinutes(m) && (m < limits.band_min || m > limits.band_max)) {
    return { kind: "error", code: "outside_band", error: `Your kitchen can set ${limits.band_min} to ${limits.band_max} minutes. ${ASK_DISPATCH}` };
  }
  const choices = cookTimeChoices(limits);
  if (typeof m !== "number" || !choices.includes(m)) return { kind: "error", code: "invalid_cook_time", error: `Pick a cook time: ${choices.join(", ")} minutes.` };
  return { kind: "ok", minutes: m };
}

export type BusyRequest =
  | { kind: "end" }
  | { kind: "start"; minutes: number; lengthMinutes: number }
  | { kind: "error"; code: string; error: string };

const wholePositive = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** POST /api/dashboard/store/busy: { minutes, length_minutes } starts a boost, { end: true } ends it. */
export function parseBusyRequest(input: unknown, limits: CookLimits = DEFAULT_COOK_LIMITS): BusyRequest {
  const o = (input ?? {}) as Record<string, unknown>;
  if (o.end === true) return { kind: "end" };
  if (!wholePositive(o.minutes)) return { kind: "error", code: "invalid_boost", error: "Pick how many minutes to add." };
  if (!wholePositive(o.length_minutes)) return { kind: "error", code: "invalid_length", error: "Pick how long you're busy for." };
  if (o.minutes > limits.max_boost_minutes) return { kind: "error", code: "boost_too_big", error: `Busy can add at most ${limits.max_boost_minutes} minutes. ${ASK_DISPATCH}` };
  if (o.length_minutes > limits.max_length_minutes) return { kind: "error", code: "busy_too_long", error: `Busy can last at most ${lengthLabel(limits.max_length_minutes)}. ${ASK_DISPATCH}` };
  return { kind: "start", minutes: o.minutes, lengthMinutes: o.length_minutes };
}

export interface LiveBusy {
  minutes: number;
  started_at: string | null;
  until: string;
  started_by: string | null;
}

export interface BusyColumns {
  busy_boost_minutes?: number | null;
  busy_started_at?: string | null;
  busy_until?: string | null;
  busy_started_by?: string | null;
}

/** The boost in force, or null when none or already over. The clock decides, so it ends on time whether or not the sweep has run. */
export function liveBusy(row: BusyColumns | null | undefined, now: number): LiveBusy | null {
  if (!row?.busy_boost_minutes || !row.busy_until) return null;
  const until = Date.parse(row.busy_until);
  if (Number.isNaN(until) || until <= now) return null;
  return { minutes: row.busy_boost_minutes, started_at: row.busy_started_at ?? null, until: row.busy_until, started_by: row.busy_started_by ?? null };
}

/** What Accept pre-selects: default + boost, kept under the ceiling orders.ready_minutes allows. */
export function acceptMinutes(prepMinutes: number, busy: Pick<LiveBusy, "minutes"> | null | undefined): number {
  return Math.min(prepMinutes + (busy?.minutes ?? 0), MAX_PREP_MINUTES);
}

const hhmmToMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * When the range the restaurant is open in right now closes, or null when it
 * is not open by its hours (or none are on file). Yesterday is checked too: a
 * bar open 16:00-02:00 is still in yesterday's range at 1 AM.
 */
export function nextCloseAt(hours: unknown, now: Date, zone: string): Date | null {
  if (!hours || typeof hours !== "object") return null;
  const week = hours as Record<string, unknown>;
  const today = zonedParts(now, zone);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  let soonest: Date | null = null;
  for (const dayOffset of [-1, 0]) {
    const day = new Date(todayUtc + dayOffset * 86_400_000);
    const ranges = week[DAY_KEYS[day.getUTCDay()]!];
    if (!Array.isArray(ranges)) continue;
    for (const r of ranges as Partial<TimeRange>[]) {
      if (typeof r?.open !== "string" || typeof r?.close !== "string") continue;
      const open = hhmmToMinutes(r.open);
      const close = hhmmToMinutes(r.close);
      if (Number.isNaN(open) || Number.isNaN(close)) continue;
      const at = (minutes: number, plusDays: number) => {
        const d = new Date(day.getTime() + plusDays * 86_400_000);
        return zonedInstant(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(minutes / 60), minutes % 60);
      };
      const openAt = at(open, 0);
      const closeAt = at(close, close <= open ? 1 : 0);
      if (openAt <= now && now < closeAt && (!soonest || closeAt < soonest)) soonest = closeAt;
    }
  }
  return soonest;
}

/** A boost ends at the chosen length or at close, whichever is first. */
export function busyEndsAt(now: Date, lengthMinutes: number, closeAt: Date | null): Date {
  const chosen = new Date(now.getTime() + lengthMinutes * 60_000);
  return closeAt && closeAt < chosen ? closeAt : chosen;
}

/** "30 min", "1 hour", "2 hours", "90 min". */
export function lengthLabel(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} min`;
  const h = minutes / 60;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** The banner over the orders: "Busy: +15 min until 7:30 PM". */
export function busyLine(busy: Pick<LiveBusy, "minutes" | "until">, zone: string): string {
  return `Busy: +${busy.minutes} min until ${clockLabel(new Date(busy.until), zone)}`;
}

/** What the CRM may send as limits: each a whole number in range, or null to go back to the default. */
export function parseCookLimits(input: unknown, current: CookLimitColumns | null | undefined): { kind: "ok"; columns: Required<CookLimitColumns> } | { kind: "error"; code: string; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { kind: "error", code: "invalid_limits", error: "limits must be an object" };
  const given = input as Record<string, unknown>;
  const columnFor: Record<keyof CookLimits, keyof CookLimitColumns> = {
    max_boost_minutes: "cook_max_boost_minutes",
    max_length_minutes: "cook_max_busy_minutes",
    band_min: "cook_band_min",
    band_max: "cook_band_max",
  };
  const columns: Required<CookLimitColumns> = {
    cook_max_boost_minutes: current?.cook_max_boost_minutes ?? null,
    cook_max_busy_minutes: current?.cook_max_busy_minutes ?? null,
    cook_band_min: current?.cook_band_min ?? null,
    cook_band_max: current?.cook_band_max ?? null,
  };
  let any = false;
  for (const key of Object.keys(columnFor) as (keyof CookLimits)[]) {
    if (!(key in given)) continue;
    any = true;
    const v = given[key];
    const range = LIMIT_RANGES[key];
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < range.min || v > range.max)) {
      return { kind: "error", code: "invalid_limits", error: `${key} must be a whole number from ${range.min} to ${range.max}, or null for the default` };
    }
    columns[columnFor[key]] = v as number | null;
  }
  if (!any) return { kind: "error", code: "invalid_limits", error: "send at least one of: max_boost_minutes, max_length_minutes, band_min, band_max" };
  const effective = cookLimitsOf(columns);
  if (effective.band_min > effective.band_max) return { kind: "error", code: "invalid_limits", error: `band_min (${effective.band_min}) is above band_max (${effective.band_max})` };
  return { kind: "ok", columns };
}

// --- the change log -----------------------------------------------------------

export type CookTimeKind = "default_change" | "boost_start" | "boost_end" | "boost_expire" | "running_late";
export type CookTimeSource = "tablet" | "partner_app" | "crm" | "system";

/** A cook_time_log row to write. Only what a kind carries; the rest stays null. */
export interface CookTimeLogInsert {
  restaurant_id: string;
  kind: CookTimeKind;
  source: CookTimeSource;
  actor: string | null;
  before_minutes?: number | null;
  after_minutes?: number | null;
  boost_minutes?: number | null;
  expires_at?: string | null;
  order_id?: string | null;
  order_number?: string | null;
  before_ready_by?: string | null;
  after_ready_by?: string | null;
  minutes_added?: number | null;
}

type Who = { source: CookTimeSource; actor: string | null };

export const defaultChangeLog = (restaurantId: string, before: number, after: number, who: Who): CookTimeLogInsert => ({
  restaurant_id: restaurantId,
  kind: "default_change",
  ...who,
  before_minutes: before,
  after_minutes: after,
});

export const boostStartLog = (restaurantId: string, prepMinutes: number, boost: number, until: string, who: Who): CookTimeLogInsert => ({
  restaurant_id: restaurantId,
  kind: "boost_start",
  ...who,
  before_minutes: prepMinutes,
  after_minutes: acceptMinutes(prepMinutes, { minutes: boost }),
  boost_minutes: boost,
  expires_at: until,
});

export const boostEndLog = (restaurantId: string, prepMinutes: number, busy: Pick<LiveBusy, "minutes" | "until">, who: Who): CookTimeLogInsert => ({
  restaurant_id: restaurantId,
  kind: "boost_end",
  ...who,
  before_minutes: acceptMinutes(prepMinutes, busy),
  after_minutes: prepMinutes,
  boost_minutes: busy.minutes,
  expires_at: busy.until,
});

/** Running late: how far the promise moved. Null minutes_added when there was no ready time to move from. */
export function runningLateLog(
  order: { id: string; restaurant_id: string; order_number?: string | null; ready_by?: string | null },
  afterReadyBy: string | null,
  who: Who
): CookTimeLogInsert {
  const before = Date.parse(order.ready_by ?? "");
  const after = Date.parse(afterReadyBy ?? "");
  return {
    restaurant_id: order.restaurant_id,
    kind: "running_late",
    ...who,
    order_id: order.id,
    order_number: order.order_number ?? null,
    before_ready_by: order.ready_by ?? null,
    after_ready_by: afterReadyBy,
    minutes_added: Number.isNaN(before) || Number.isNaN(after) ? null : Math.round((after - before) / 60_000),
  };
}
