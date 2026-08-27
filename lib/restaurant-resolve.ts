import { supabaseAdmin } from "./supabase-server";

/**
 * Find - or create - the restaurant a CRM request is talking about.
 *
 * The CRM is the system of record for which restaurants exist. This database
 * only knows the ones someone added by hand, so a perfectly real restaurant
 * can be absent here. Answering "restaurant not found" in that case is
 * technically true and operationally useless: it blocks a legitimate action
 * over a bookkeeping gap the operator cannot see or fix from the console.
 *
 * A restaurant created this way starts with no Zuppler mapping, which is
 * correct - it has not been onboarded yet - and the health check already
 * reports exactly that, so the gap stays visible instead of becoming silent.
 */

export interface ResolveInput {
  /** This database's own uuid, when the caller already knows it. */
  restaurantId?: unknown;
  /** The CRM's id for the restaurant. */
  crmRestaurantId?: unknown;
  /** Required only when a row may have to be created. */
  restaurantName?: unknown;
}

/**
 * One shape rather than a discriminated union: this project compiles with
 * strict:false, where narrowing on a literal boolean is unreliable, and a
 * result type that only type-checks under strict is a trap for the next
 * person. `restaurant` is present exactly when `error` is not.
 */
export interface ResolveResult {
  restaurant?: { id: string; name: string };
  created?: boolean;
  error?: string;
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL-safe slug; restaurants.slug is expected to be unique. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "restaurant";
}

export async function resolveOrCreateRestaurant(
  input: ResolveInput
): Promise<ResolveResult> {
  const admin = supabaseAdmin();
  const ourId = str(input.restaurantId);
  const crmId = str(input.crmRestaurantId);
  const name = str(input.restaurantName);

  // 1. Our own uuid, when it really is one of ours.
  if (ourId && UUID_RE.test(ourId)) {
    const { data } = await admin
      .from("restaurants")
      .select("id, name")
      .eq("id", ourId)
      .maybeSingle();
    if (data) return { restaurant: data, created: false };
  }

  // 2. Previously linked to this CRM record. An id we did not recognise as
  //    ours is treated as the CRM's, which is what it will be in practice.
  const externalId = crmId ?? (ourId && !UUID_RE.test(ourId) ? ourId : null) ?? ourId;
  if (externalId) {
    const { data } = await admin
      .from("restaurants")
      .select("id, name")
      .eq("crm_restaurant_id", externalId)
      .maybeSingle();
    if (data) return { restaurant: data, created: false };
  }

  // 3. Create. A name is genuinely required - a row named after an opaque id
  //    would print as the ticket header in someone's kitchen.
  if (!name) {
    return {
      error:
        "restaurant not found here, and restaurant_name was not supplied - send the name so the restaurant can be created",
    };
  }
  if (!externalId) {
    return { error: "restaurant_id or crm_restaurant_id is required" };
  }

  const insert = async (slug: string) =>
    admin
      .from("restaurants")
      .insert({ name, slug, crm_restaurant_id: externalId, is_active: true })
      .select("id, name")
      .single();

  let { data, error } = await insert(slugify(name));
  if (error?.code === "23505") {
    // Either the slug collided, or another request created this restaurant
    // between our lookup and our insert. Check the latter first: returning
    // the existing row is the whole point of find-or-create.
    const { data: raced } = await admin
      .from("restaurants")
      .select("id, name")
      .eq("crm_restaurant_id", externalId)
      .maybeSingle();
    if (raced) return { restaurant: raced, created: false };

    const retry = await insert(
      `${slugify(name)}-${Math.random().toString(36).slice(2, 7)}`
    );
    data = retry.data;
    error = retry.error;
  }
  if (error) return { error: error.message };

  return { restaurant: data!, created: true };
}
