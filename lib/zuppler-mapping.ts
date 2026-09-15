/**
 * Which Zuppler listings a restaurant owns.
 *
 * Zuppler models a pickup menu, a catering menu and a delivery menu as
 * separate locations with separate ids, and all of them belong to one
 * kitchen with one printer. An order arriving on an id nobody mapped is
 * recorded as `unmapped` and dropped - which is how Larry's pickup listing
 * (32712) refused a live order on 2026-09-15 while the CRM had known about
 * that listing for weeks. The CRM is the system that knows which listings
 * are whose; this is the pure half of letting it say so.
 *
 * Two places hold the mapping and both are honoured on ingest:
 *   - restaurants.zuppler_restaurant_id: the legacy single column. Still the
 *     one accounting joins on, so it must carry the PRIMARY listing.
 *   - restaurant_zuppler_ids: one row per listing, any number per restaurant.
 */

export interface RequestedListing {
  zuppler_restaurant_id: string;
  label?: string | null;
}

export interface ExistingMapping {
  zuppler_restaurant_id: string;
  restaurant_id: string;
  restaurant_name: string;
}

export interface MappingPlan {
  /** Rows to upsert into restaurant_zuppler_ids. */
  upserts: { zuppler_restaurant_id: string; restaurant_id: string; label: string | null }[];
  /** Set restaurants.zuppler_restaurant_id to this, or leave it alone (null). */
  setPrimary: string | null;
}

export type MappingOutcome = { plan: MappingPlan } | { error: string; status: 400 | 409 };

const DIGITS = /^\d+$/;

/**
 * Decide what to write, or refuse.
 *
 * Refuses the whole request rather than writing the ids that were fine: a
 * half-applied mapping is exactly the state that produced silent drops, and
 * the caller (the CRM) can show the conflict and ask.
 *
 * `existing` is every mapping the bridge has for any of the requested ids,
 * from BOTH tables, with the owning restaurant named so the 409 can say who.
 */
export function planZupplerMapping(args: {
  restaurantId: string;
  currentPrimary: string | null;
  requested: RequestedListing[];
  existing: ExistingMapping[];
}): MappingOutcome {
  const { restaurantId, currentPrimary, requested, existing } = args;

  if (!requested.length) {
    return { error: "zuppler_ids must list at least one listing", status: 400 };
  }

  const seen = new Set<string>();
  const cleaned: RequestedListing[] = [];
  for (const r of requested) {
    const id = String(r?.zuppler_restaurant_id ?? "").trim();
    // A typo here fails silently later - the order is accepted and dropped
    // as unmapped - so reject it now while somebody is watching.
    if (!DIGITS.test(id)) {
      return { error: `Zuppler id "${id}" must be digits only, e.g. 29924`, status: 400 };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 120) : null;
    cleaned.push({ zuppler_restaurant_id: id, label });
  }

  // An id can belong to one kitchen. Two rows claiming it would split one
  // listing's orders between two printers, and nothing reports that.
  for (const e of existing) {
    if (e.restaurant_id !== restaurantId && seen.has(e.zuppler_restaurant_id)) {
      return {
        error: `Zuppler id ${e.zuppler_restaurant_id} is already mapped to "${e.restaurant_name}". Unmap it there first, or link to that restaurant instead.`,
        status: 409,
      };
    }
  }

  return {
    plan: {
      upserts: cleaned.map((c) => ({
        zuppler_restaurant_id: c.zuppler_restaurant_id,
        restaurant_id: restaurantId,
        label: c.label ?? null,
      })),
      // The first id the caller sends is the primary listing. Only fill an
      // empty column: a primary somebody set on purpose is not overwritten
      // by a sync, because accounting joins on it.
      setPrimary: currentPrimary ? null : cleaned[0].zuppler_restaurant_id,
    },
  };
}
