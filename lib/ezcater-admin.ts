import { supabaseAdmin } from "./supabase-server";
import { ezCaterOrderToCanonical } from "./ezcater";
import {
  createOrderSubscription,
  createSubscriber,
  deleteCatererSubscriptions,
  ezCaterTokenConfigured,
  fetchEzCaterOrderRaw,
  listCaterers,
  listSubscribers,
  mapEzCaterOrder,
  type EzCaterCaterer,
} from "./ezcater-client";

/**
 * /admin/ezcater's actions (Phase 2). Everything that talks to ezCater runs
 * here, in the deployment, because EZCATER_API_TOKEN exists only in Vercel
 * production - the same reason prs-crm runs its production probes as pages.
 */

/**
 * The order events each ACTIVE location subscribes to. ezCater has no
 * "modified" event: a modification is a second `accepted` for the same order
 * id (https://api.ezcater.io/order-modifications), so these two cover
 * accepted / modified / cancelled. `uncancelled` is deliberately not here
 * yet - reviving a cancelled order is a decision for when tickets print.
 */
export const EZCATER_SUBSCRIBED_EVENTS = ["accepted", "cancelled"] as const;

/**
 * Matt, 2026-09-28: the six PFD locations on ezCater - their full caterer
 * uuids, as ezCater shows them - and the restaurant each belongs to. The uuid
 * is matched exactly. The restaurant is the one bridge restaurant whose name
 * equals the seed's name, else the one whose name contains its `match` word
 * - exactly one either way, or it is reported, never guessed. The seed
 * creates a location row it does not have yet (so linking does not wait on
 * the Caterers sync) and links it; it never activates - Willie Mae's is
 * switched on by hand, the rest stay off "until I say".
 */
export const EZCATER_SEED: ReadonlyArray<{ uuid: string; label: string; match: string }> = [
  { uuid: "7f2a4942-1cc8-48ad-94d7-3dd09b241fb1", label: "Willie Mae's Barbeque", match: "willie mae" },
  { uuid: "0996f96f-fd68-44f6-9db1-da4d54cd876b", label: "Larry's", match: "larry" },
  { uuid: "7a0e1f7d-af97-43a4-9bda-d6f757407f9f", label: "Sylfoni's Pizza", match: "sylfoni" },
  { uuid: "f72aee20-8e5d-49ed-bb77-114209078e19", label: "El Molcajete", match: "molcajete" },
  { uuid: "e818e720-1594-4a4f-868d-ff012fc1e29a", label: "All Seasons Sports Grill", match: "all seasons" },
  { uuid: "43a61b77-a508-4adc-b8a7-be3b24563820", label: "Torino's Greek & Italian", match: "torino" },
];

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export interface SeedOutcome {
  uuid: string;
  label: string;
  catererUuid: string | null;
  catererName: string | null;
  restaurantId: string | null;
  restaurantName: string | null;
  result: "linked" | "already_linked" | "caterer_missing" | "restaurant_missing" | "restaurant_ambiguous" | "linked_elsewhere";
  detail?: string;
}

/** Pure: the one restaurant a seed row names - exact name first, then the one containing its match word. */
export function seedRestaurant(s: { label: string; match: string }, restaurants: Array<{ id: string; name: string | null }>): { pick: { id: string; name: string | null } | null; ambiguous: string[] } {
  const exact = restaurants.filter((r) => norm(r.name) === norm(s.label));
  if (exact.length === 1) return { pick: exact[0], ambiguous: [] };
  const byWord = restaurants.filter((r) => ` ${norm(r.name)} `.includes(` ${s.match}`));
  if (byWord.length === 1) return { pick: byWord[0], ambiguous: [] };
  return { pick: null, ambiguous: (exact.length > 1 ? exact : byWord).map((r) => r.name ?? r.id) };
}

/** Pure: which caterer and which restaurant a seed row points at. */
export function planSeed(
  caterers: Array<{ caterer_uuid: string; name: string; restaurant_id: string | null }>,
  restaurants: Array<{ id: string; name: string | null }>
): SeedOutcome[] {
  return EZCATER_SEED.map((s) => {
    const base = { uuid: s.uuid, label: s.label, catererUuid: null, catererName: null, restaurantId: null, restaurantName: null };
    const c = caterers.find((x) => x.caterer_uuid.toLowerCase() === s.uuid);
    if (!c) return { ...base, result: "caterer_missing" as const };
    const withCaterer = { ...base, catererUuid: c.caterer_uuid, catererName: c.name };
    const { pick, ambiguous } = seedRestaurant(s, restaurants);
    if (!pick && ambiguous.length === 0) return { ...withCaterer, result: "restaurant_missing" as const };
    if (!pick) return { ...withCaterer, result: "restaurant_ambiguous" as const, detail: ambiguous.join(", ") };
    const r = pick;
    const out = { ...withCaterer, restaurantId: r.id, restaurantName: r.name };
    if (c.restaurant_id === r.id) return { ...out, result: "already_linked" as const };
    // A location someone already linked to a different restaurant is never overwritten by the seed.
    if (c.restaurant_id) return { ...out, result: "linked_elsewhere" as const, detail: `linked to ${c.restaurant_id}` };
    return { ...out, result: "linked" as const };
  });
}

export interface SyncResult {
  caterers: EzCaterCaterer[];
  /** Matt: "Confirm the Caterers query returns all six." One line per seed row: ezCater's name for that uuid, or null when the query did not return it. */
  seedCheck: Array<{ uuid: string; label: string; found: string | null }>;
}

/** Runs the Caterers query and upserts every location. Never touches a link or the active flag. */
export async function syncCaterers(): Promise<SyncResult> {
  const caterers = await listCaterers();
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  if (caterers.length) {
    const { error } = await admin.from("ezcater_locations").upsert(
      caterers.map((c) => ({ caterer_uuid: c.uuid, name: c.name, store_number: c.storeNumber, address: c.address, live: c.live, last_synced_at: now, updated_at: now })),
      { onConflict: "caterer_uuid" }
    );
    if (error) throw new Error(`ezcater_locations upsert: ${error.message}`);
  }
  return {
    caterers,
    seedCheck: EZCATER_SEED.map((s) => ({ uuid: s.uuid, label: s.label, found: caterers.find((c) => c.uuid.toLowerCase() === s.uuid)?.name ?? null })),
  };
}

export async function applySeed(actor: string): Promise<SeedOutcome[]> {
  const admin = supabaseAdmin();
  // The six are known by full uuid, so their rows can exist before the first
  // Caterers sync (which then fills store number, address and ezCater's own
  // name). ignoreDuplicates: a row the sync already wrote is left as it is.
  const { error: seedError } = await admin
    .from("ezcater_locations")
    .upsert(EZCATER_SEED.map((s) => ({ caterer_uuid: s.uuid, name: s.label })), { onConflict: "caterer_uuid", ignoreDuplicates: true });
  if (seedError) throw new EzCaterAdminError(`seed rows: ${seedError.message}`);
  const [{ data: caterers }, { data: restaurants }] = await Promise.all([
    admin.from("ezcater_locations").select("caterer_uuid, name, restaurant_id"),
    admin.from("restaurants").select("id, name"),
  ]);
  const plan = planSeed(caterers ?? [], restaurants ?? []);
  const now = new Date().toISOString();
  for (const p of plan) {
    if (p.result !== "linked") continue;
    const { error } = await admin
      .from("ezcater_locations")
      .update({ restaurant_id: p.restaurantId, mapped_at: now, mapped_by: actor, updated_at: now })
      .eq("caterer_uuid", p.catererUuid!)
      .is("restaurant_id", null);
    if (error) Object.assign(p, { result: "restaurant_missing", detail: error.message });
  }
  return plan;
}

export class EzCaterAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EzCaterAdminError";
  }
}

/**
 * Creates THE subscriber, pointing at this deployment's webhook, and stores
 * the one-time secret. If ezCater already has a subscriber for this API user
 * and we do not hold its secret, we cannot verify its notifications - that is
 * said plainly rather than worked around.
 */
export async function ensureSubscriber(webhookUrl: string, actor: string): Promise<{ id: string; webhookUrl: string; created: boolean }> {
  const admin = supabaseAdmin();
  const { data: mine } = await admin.from("ezcater_subscriber").select("id, webhook_url").limit(1).maybeSingle();
  if (mine) return { id: mine.id, webhookUrl: mine.webhook_url, created: false };
  const existing = await listSubscribers();
  if (existing.length) {
    throw new EzCaterAdminError(
      `ezCater already has a subscriber for this API user (${existing[0].id}, ${existing[0].webhookUrl}) and its webhook secret was only shown when it was created. Set EZCATER_WEBHOOK_SECRET in Vercel if you have it; otherwise ask integrations@ezcater.com to remove that subscriber, then create it here.`
    );
  }
  const s = await createSubscriber("PFD Order Monitor", webhookUrl);
  const { error } = await admin.from("ezcater_subscriber").insert({ id: s.id, name: s.name, webhook_url: s.webhookUrl, webhook_secret: s.webhookSecret, created_by: actor });
  if (error) {
    // The secret exists nowhere else. Say so loudly - the subscriber must be recreated if this row is lost.
    console.error("ezCater subscriber CREATED BUT NOT STORED - its webhook secret is lost:", s.id, error.message);
    throw new EzCaterAdminError(`Subscriber ${s.id} was created at ezCater but could not be stored (${error.message}). Its secret is lost; ask ezCater to remove it and create it again.`);
  }
  console.log("ezCater subscriber created", { id: s.id, webhookUrl: s.webhookUrl, by: actor });
  return { id: s.id, webhookUrl: s.webhookUrl, created: true };
}

/**
 * Link a location to a restaurant (or unlink), and switch it on or off.
 * On: subscribe first, then flip `active` - a location is never active
 * without its subscriptions. Off: delete its subscriptions at ezCater, then
 * flip. Unlinking an active location is refused; switch it off first.
 */
export async function setLocation(catererUuid: string, change: { restaurantId?: string | null; active?: boolean }, actor: string, webhookUrl: string) {
  const admin = supabaseAdmin();
  const { data: loc } = await admin.from("ezcater_locations").select("*").eq("caterer_uuid", catererUuid).maybeSingle();
  if (!loc) throw new EzCaterAdminError("No such ezCater location - run Sync caterers first.");
  const now = new Date().toISOString();
  const restaurantId = change.restaurantId === undefined ? loc.restaurant_id : change.restaurantId;
  if (loc.active && change.restaurantId !== undefined && change.restaurantId !== loc.restaurant_id) {
    throw new EzCaterAdminError("Switch the location off before changing its restaurant.");
  }

  let subscribed: string[] = loc.subscribed_events ?? [];
  let active: boolean = loc.active;
  if (change.active === true && !loc.active) {
    if (!restaurantId) throw new EzCaterAdminError("Link a restaurant before switching the location on.");
    const sub = await ensureSubscriber(webhookUrl, actor);
    for (const key of EZCATER_SUBSCRIBED_EVENTS) {
      if (subscribed.includes(key)) continue;
      await createOrderSubscription(sub.id, catererUuid, key);
      subscribed = [...subscribed, key];
      // Record each one as it lands, so a failure part-way leaves an honest row.
      await admin.from("ezcater_locations").update({ subscribed_events: subscribed, updated_at: now }).eq("caterer_uuid", catererUuid);
    }
    active = true;
  } else if (change.active === false && loc.active) {
    await deleteCatererSubscriptions(catererUuid);
    subscribed = [];
    active = false;
  }

  const { error } = await admin
    .from("ezcater_locations")
    .update({
      restaurant_id: restaurantId,
      active,
      subscribed_events: subscribed,
      ...(change.restaurantId !== undefined ? { mapped_at: now, mapped_by: actor } : {}),
      updated_at: now,
    })
    .eq("caterer_uuid", catererUuid);
  if (error) throw new EzCaterAdminError(error.message);
  console.log("ezCater location changed", { catererUuid, restaurantId, active, subscribed, by: actor });
}

/** Fetch and map one order WITHOUT storing anything - to see an order the way ingest would. */
export async function dryRunOrder(orderId: string) {
  const raw = await fetchEzCaterOrderRaw(orderId);
  if (!raw) return { found: false as const };
  const order = mapEzCaterOrder(raw);
  const { data: loc } = await supabaseAdmin().from("ezcater_locations").select("name, active, restaurant_id, restaurants(id, name)").eq("caterer_uuid", order.catererLocationId).maybeSingle();
  const restaurant = (loc as any)?.restaurants ?? { id: loc?.restaurant_id ?? "(no restaurant linked)", name: null };
  return { found: true as const, location: loc ? { name: loc.name, active: loc.active } : null, order, canonical: ezCaterOrderToCanonical(order, restaurant), raw };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function getEzCaterState() {
  const admin = supabaseAdmin();
  const [locations, subscriber, restaurants, receipts, orders] = await Promise.all([
    admin.from("ezcater_locations").select("caterer_uuid, name, store_number, address, live, restaurant_id, active, subscribed_events, last_synced_at, mapped_at, mapped_by").order("name"),
    // Never the secret.
    admin.from("ezcater_subscriber").select("id, name, webhook_url, created_at, created_by").limit(1).maybeSingle(),
    admin.from("restaurants").select("id, name, crm_restaurant_id").order("name"),
    admin.from("webhook_receipts").select("received_at, status, http_status, order_uuid, detail").eq("source", "ezcater").order("received_at", { ascending: false }).limit(20),
    admin.from("ezcater_orders").select("ezcater_order_id, caterer_uuid, order_number, status, fulfillment, event_time, customer_total, event_count, modified_at, cancelled_at, first_seen_at, updated_at").order("updated_at", { ascending: false }).limit(20),
  ]);
  return {
    tokenConfigured: ezCaterTokenConfigured(),
    webhookSecretOverride: !!process.env.EZCATER_WEBHOOK_SECRET?.trim(),
    locations: locations.data ?? [],
    subscriber: subscriber.data ?? null,
    restaurants: restaurants.data ?? [],
    receipts: receipts.data ?? [],
    orders: orders.data ?? [],
    subscribedEvents: EZCATER_SUBSCRIBED_EVENTS,
  };
}
