import { UUID_RE } from "./restaurant-ref";

/**
 * Relink a restaurant here to a different CRM account (R1, Nick 2026-09-24).
 *
 * The CRM merges duplicate accounts. Before this existed it could not: the
 * bridge restaurant was linked to the duplicate, and nothing could move
 * `restaurants.crm_restaurant_id` after creation, so merging would have left
 * the restaurant's printers, tablets and orders pointing at an account that
 * no longer exists.
 *
 * The link is the restaurant, not its children. Printers, tablets, logins,
 * heartbeats and orders all hang off `restaurants.id`, which never changes,
 * so moving the one column moves everything - including every order from
 * before the relink. No other table stores a CRM account id.
 *
 * The decision is written against a small store interface so the whole rule
 * set can be tested without a database; the route supplies the Supabase one.
 */

export interface LinkedRestaurant {
  id: string;
  name: string | null;
  crm_restaurant_id: string | null;
}

export interface RelinkStore {
  /** A restaurant by either id (lib/restaurant-ref.ts). */
  findByRef(ref: string): Promise<LinkedRestaurant | null>;
  /** Another restaurant that already answers to `value` - as its CRM account, or as its own id. */
  findOtherHolder(value: string, exceptId: string): Promise<LinkedRestaurant | null>;
  /** Set the one column. "taken" when the unique index refuses it (a race with another relink). */
  setCrmRestaurantId(id: string, value: string): Promise<"ok" | "taken">;
  writeAudit(row: { restaurant_id: string; old_crm_restaurant_id: string | null; new_crm_restaurant_id: string; actor: string | null }): Promise<string | null>;
}

export type RelinkInput = { crm_restaurant_id: string; actor: string | null };

export type ParseResult = { ok: true; input: RelinkInput } | { ok: false; code: string; error: string };

export function parseRelinkBody(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "invalid_body", error: "a JSON body is required" };
  }
  const b = body as Record<string, unknown>;
  const raw = typeof b.crm_restaurant_id === "string" ? b.crm_restaurant_id.trim() : "";
  if (!UUID_RE.test(raw)) {
    return { ok: false, code: "invalid_crm_restaurant_id", error: "crm_restaurant_id must be the CRM account's uuid" };
  }
  const actor = typeof b.actor === "string" && b.actor.trim() ? b.actor.trim().slice(0, 200) : null;
  // CRM account ids are Postgres uuids, which it prints lower-case; one case
  // here keeps the unique index and every later lookup honest.
  return { ok: true, input: { crm_restaurant_id: raw.toLowerCase(), actor } };
}

export type RelinkOutcome =
  | { status: 200; changed: boolean; restaurant: LinkedRestaurant; previous_crm_restaurant_id: string | null; warning?: string }
  | { status: 400 | 404 | 409; code: string; error: string };

export async function relinkRestaurant(store: RelinkStore, ref: string, body: unknown): Promise<RelinkOutcome> {
  const parsed = parseRelinkBody(body);
  if (!parsed.ok) {
    const { code, error } = parsed as Extract<ParseResult, { ok: false }>;
    return { status: 400, code, error };
  }
  const { crm_restaurant_id: next, actor } = parsed.input;

  const restaurant = await store.findByRef(ref);
  if (!restaurant) return { status: 404, code: "restaurant_not_found", error: "restaurant not found" };

  const previous = restaurant.crm_restaurant_id;
  if ((previous ?? "").toLowerCase() === next) {
    return { status: 200, changed: false, restaurant, previous_crm_restaurant_id: previous };
  }

  // Never two restaurants answering to one reference. That includes another
  // restaurant's own id: every CRM route resolves a reference against both
  // columns, so that collision would make lookups ambiguous just the same.
  const holder = await store.findOtherHolder(next, restaurant.id);
  if (holder) return taken(holder, next);

  if ((await store.setCrmRestaurantId(restaurant.id, next)) === "taken") {
    const racer = await store.findOtherHolder(next, restaurant.id);
    return taken(racer ?? { id: "unknown", name: null, crm_restaurant_id: next }, next);
  }

  const auditError = await store.writeAudit({
    restaurant_id: restaurant.id,
    old_crm_restaurant_id: previous,
    new_crm_restaurant_id: next,
    actor,
  });
  return {
    status: 200,
    changed: true,
    restaurant: { ...restaurant, crm_restaurant_id: next },
    previous_crm_restaurant_id: previous,
    // The relink stands - undoing it would be worse - but a missing audit row
    // is said out loud rather than discovered later.
    ...(auditError ? { warning: `relinked, but the audit row was not written: ${auditError}` } : {}),
  };
}

function taken(holder: LinkedRestaurant, value: string): RelinkOutcome {
  return {
    status: 409,
    code: "crm_account_taken",
    error: `CRM account ${value} is already linked to another restaurant here: ${holder.name ?? "(unnamed)"} (${holder.id}). Two restaurants are never merged by a relink - move or unlink that one first.`,
  };
}
