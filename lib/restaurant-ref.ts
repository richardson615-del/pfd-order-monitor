import { supabaseAdmin } from "./supabase-server";

/**
 * A restaurant, by either of its two ids.
 *
 * Every restaurant here has its own uuid (`restaurants.id`) and, once the
 * CRM has linked it, the CRM's account id (`restaurants.crm_restaurant_id`,
 * migration 007). They are NOT the same value: lib/restaurant-resolve.ts
 * creates the row with a fresh uuid and stores the CRM's id beside it.
 * The systems map used to say they were equal, and every CRM-facing
 * tablet route was written as if they were - so the CRM's assign push,
 * "Link tablet" and the kiosk bootstrap looked the CRM's account id up in
 * `restaurants.id`, found nothing, and answered "restaurant not found"
 * for every restaurant. (Nick, 2026-09-17, from the production roster:
 * Twisted Fork 371eaaa3-… here, 9ae1f031-… in the CRM.)
 *
 * So a reference from the CRM resolves against BOTH columns, and every
 * route hands back the row's own `id` for whatever it writes next.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a reference may look like: a uuid, or whatever the CRM stores as an account id. Anything else is not a lookup. */
export const REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The PostgREST `.or()` filter for a reference, or null when the string
 * cannot be a reference at all. `restaurants.id` is a uuid column, so a
 * non-uuid is only ever matched against `crm_restaurant_id` - Postgres
 * would otherwise refuse the comparison, which reads as a 500 rather than
 * a 404.
 */
export function restaurantRefFilter(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const r = ref.trim();
  if (!REF_RE.test(r)) return null;
  return UUID_RE.test(r) ? `id.eq.${r},crm_restaurant_id.eq.${r}` : `crm_restaurant_id.eq.${r}`;
}

/**
 * One restaurant by either id, with the columns asked for. Null when
 * neither column matches (or the reference is malformed).
 */
export async function findRestaurantByRef<T = any>(ref: unknown, select: string): Promise<T | null> {
  const filter = restaurantRefFilter(ref);
  if (!filter) return null;
  const { data } = await supabaseAdmin().from("restaurants").select(select).or(filter).limit(1).maybeSingle();
  return (data as T) ?? null;
}

/**
 * Many references at once (the CRM's binding push sends the whole map):
 * reference -> this database's `restaurants.id`. A reference nothing
 * matches is simply absent from the map.
 */
export async function resolveRestaurantIds(refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(refs.filter((r) => restaurantRefFilter(r)))];
  if (!wanted.length) return out;
  const uuids = wanted.filter((r) => UUID_RE.test(r));
  const admin = supabaseAdmin();
  const [{ data: byId }, { data: byCrm }] = await Promise.all([
    uuids.length ? admin.from("restaurants").select("id, crm_restaurant_id").in("id", uuids) : Promise.resolve({ data: [] as any[] }),
    admin.from("restaurants").select("id, crm_restaurant_id").in("crm_restaurant_id", wanted),
  ]);
  for (const r of (byId ?? []) as any[]) out.set(r.id, r.id);
  for (const r of (byCrm ?? []) as any[]) if (r.crm_restaurant_id) out.set(r.crm_restaurant_id, r.id);
  return out;
}
