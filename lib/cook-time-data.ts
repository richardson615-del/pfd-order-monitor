import { prepMinutesOf } from "./countdown";
import { bearerToken } from "./partner-app";
import { emailToUsername } from "./usernames";
import { BUSY_SELECT, boostEndLog, liveBusy, type BusyColumns, type CookTimeKind, type CookTimeLogInsert, type CookTimeSource, type LiveBusy } from "./cook-time";

/**
 * The database half of busy-time cook time (BT1, migration 058): the change log
 * and the writes both the tablet and the CRM make. Server only. The client is
 * passed in, so the reads can be asserted without a database.
 */

// The supabase client's builder type is not worth threading through here.
type Admin = any;

/** The most a single read of the log returns. */
export const COOK_LOG_MAX = 500;
export const COOK_LOG_DEFAULT = 200;

/** Which app made the change: PFD Partner sends a Bearer token, the tablet a cookie. */
export const cookSourceOf = (authorization: string | null): CookTimeSource => (bearerToken(authorization) ? "partner_app" : "tablet");

/** Who to name in the log: the tablet login's username, never a made-up address. */
export function actorOf(user: { id: string; email?: string | null } | null | undefined): string | null {
  if (!user) return null;
  return (user.email ? (emailToUsername(user.email) ?? user.email) : null) ?? user.id;
}

/**
 * Write one log row. A failed write is logged and never undoes the change: a
 * kitchen pressing Running late must not be refused because the audit trail
 * could not be written.
 */
export async function recordCookTimeChange(admin: Admin, row: CookTimeLogInsert): Promise<boolean> {
  try {
    const { error } = await admin.from("cook_time_log").insert(row);
    if (!error) return true;
    console.error("cook_time_log: write failed -", error.message, JSON.stringify({ kind: row.kind, restaurant: row.restaurant_id }));
  } catch (err) {
    console.error("cook_time_log: write failed -", err instanceof Error ? err.message : err);
  }
  return false;
}

/** Clear and log every boost past its end. Returns how many. */
export async function sweepExpiredBusy(admin: Admin): Promise<number> {
  const { data, error } = await admin.rpc("expire_busy_boosts");
  if (error) throw new Error(error.message);
  return typeof data === "number" ? data : 0;
}

/**
 * End the boost in force, once. The update only matches the boost this call
 * read, so a second press or an expiry at the same moment logs nothing extra.
 */
export async function endBusy(
  admin: Admin,
  restaurant: BusyColumns & { id: string; prep_minutes?: number | null },
  who: { source: CookTimeSource; actor: string | null }
): Promise<{ changed: boolean; error?: string }> {
  const live = liveBusy(restaurant, Date.now());
  if (!live) return { changed: false };
  const { data, error } = await admin
    .from("restaurants")
    .update({ busy_boost_minutes: null, busy_started_at: null, busy_until: null, busy_started_by: null })
    .eq("id", restaurant.id)
    .eq("busy_until", live.until)
    .select("id");
  if (error) return { changed: false, error: error.message };
  if (!data?.length) return { changed: false };
  await recordCookTimeChange(admin, boostEndLog(restaurant.id, prepMinutesOf(restaurant.prep_minutes), live, who));
  return { changed: true };
}

export interface CookTimeChange {
  id: number;
  restaurant: { id: string; crm_restaurant_id: string | null; name: string | null };
  kind: CookTimeKind;
  source: CookTimeSource;
  actor: string | null;
  before_minutes: number | null;
  after_minutes: number | null;
  boost_minutes: number | null;
  expires_at: string | null;
  order_id: string | null;
  order_number: string | null;
  before_ready_by: string | null;
  after_ready_by: string | null;
  minutes_added: number | null;
  created_at: string;
}

const LOG_COLUMNS =
  "id, restaurant_id, kind, source, actor, before_minutes, after_minutes, boost_minutes, expires_at, order_id, order_number, before_ready_by, after_ready_by, minutes_added, created_at";

const uniqueIds = (rows: { restaurant_id?: string; id?: string }[], key: "restaurant_id" | "id") => [...new Set(rows.map((r) => r[key]).filter((v): v is string => Boolean(v)))];

async function restaurantRefs(admin: Admin, ids: string[]): Promise<Map<string, { id: string; crm_restaurant_id: string | null; name: string | null }>> {
  if (!ids.length) return new Map();
  const { data, error } = await admin.from("restaurants").select("id, crm_restaurant_id, name").in("id", ids);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((r: any) => [r.id, { id: r.id, crm_restaurant_id: r.crm_restaurant_id ?? null, name: r.name ?? null }]));
}

function shapeChanges(rows: any[], refs: Awaited<ReturnType<typeof restaurantRefs>>): CookTimeChange[] {
  return rows.map(({ restaurant_id, ...r }) => ({
    ...r,
    restaurant: refs.get(restaurant_id) ?? { id: restaurant_id, crm_restaurant_id: null, name: null },
  }));
}

/** A log limit from a query string: the default when absent or nonsense, capped. */
export function logLimitOf(raw: string | null, fallback: number = COOK_LOG_DEFAULT): number {
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n > 0 ? Math.min(n, COOK_LOG_MAX) : fallback;
}

/** A cursor from a query string: a whole number, or null when it is not one. */
export function logCursorOf(raw: string | null): number | null {
  if (raw === null || !/^\d{1,18}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * "What changed since": oldest first by id, across every restaurant or one.
 * The cursor is the id, not a time, because an expiry is dated when the boost
 * ended and is written up to a minute later; a time cursor would skip it.
 */
export async function readCookTimeChanges(
  admin: Admin,
  args: { after?: number | null; since?: string | null; restaurantId?: string | null; limit?: number }
): Promise<{ changes: CookTimeChange[]; next_after: number | null; has_more: boolean }> {
  const limit = args.limit ?? COOK_LOG_DEFAULT;
  let q = admin.from("cook_time_log").select(LOG_COLUMNS).order("id", { ascending: true }).limit(limit + 1);
  if (args.after !== null && args.after !== undefined) q = q.gt("id", args.after);
  if (args.since) q = q.gte("created_at", args.since);
  if (args.restaurantId) q = q.eq("restaurant_id", args.restaurantId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows: any[] = data ?? [];
  const page = rows.slice(0, limit);
  const changes = shapeChanges(page, await restaurantRefs(admin, uniqueIds(page, "restaurant_id")));
  // With nothing new the caller keeps its cursor: null, never a reset to 0.
  return { changes, next_after: page.length ? page[page.length - 1].id : (args.after ?? null), has_more: rows.length > limit };
}

/** The last N changes for one restaurant, newest first (the partner page). */
export async function readRestaurantCookLog(admin: Admin, restaurantId: string, limit: number): Promise<CookTimeChange[]> {
  const { data, error } = await admin.from("cook_time_log").select(LOG_COLUMNS).eq("restaurant_id", restaurantId).order("id", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  const rows: any[] = data ?? [];
  return shapeChanges(rows, await restaurantRefs(admin, [restaurantId]));
}

export interface ActiveBusy extends LiveBusy {
  restaurant: { id: string; crm_restaurant_id: string | null; name: string | null };
}

/** Every boost in force now, or one restaurant's. */
export async function readActiveBusy(admin: Admin, now: number, restaurantId?: string | null): Promise<ActiveBusy[]> {
  let q = admin.from("restaurants").select(`id, crm_restaurant_id, name, ${BUSY_SELECT}`).gt("busy_until", new Date(now).toISOString());
  if (restaurantId) q = q.eq("id", restaurantId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const out: ActiveBusy[] = [];
  for (const r of (data ?? []) as any[]) {
    const live = liveBusy(r, now);
    if (live) out.push({ ...live, restaurant: { id: r.id, crm_restaurant_id: r.crm_restaurant_id ?? null, name: r.name ?? null } });
  }
  return out;
}
