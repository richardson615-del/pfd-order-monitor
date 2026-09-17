import { randomBytes } from "crypto";
import { supabaseAdmin } from "./supabase-server";
import { restaurantRefFilter } from "./restaurant-ref";
import { generatePassword, isValidUsername, normaliseUsername, usernameToEmail } from "./usernames";
import { orderDestinations } from "./canonical";

/**
 * Putting a restaurant live on the tablet, as one call.
 *
 * Today it is a chain across two systems: bridge restaurant row → "turn
 * tablet on" → create a login → get it to the store → test order. At ten
 * restaurants a week that chain breaks, so the CRM gets one endpoint that
 * does the bridge half and reports exactly what it did. Idempotent: the
 * second call finds everything already there and changes nothing - in
 * particular it NEVER resets a password, because the one on the wall is
 * the one that works.
 */

/**
 * The usernames to try for a restaurant, in order.
 *
 * The plain slug of the name first ("willie-maes"), then "-2", "-3"... The
 * suffix is a collision rule, not a counter anybody sees: the first name
 * that is free is the one that is used. Pure, so the rule is testable
 * without an auth server.
 */
export function usernameCandidates(restaurantName: string, max = 20): string[] {
  const slug = normaliseUsername(
    restaurantName
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
  // Cut at a word boundary, not mid-word: "ariella-restaurant-bistr" on a
  // paper ticket reads as a typo. 24 leaves room for "-19" under the
  // 31-character limit.
  let base = slug;
  if (base.length > 24) {
    const cut = base.slice(0, 24);
    const dash = cut.lastIndexOf("-");
    base = dash > 8 ? cut.slice(0, dash) : cut;
  }
  base = base || "tablet";
  const out: string[] = [];
  for (let i = 1; i <= max; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (isValidUsername(candidate)) out.push(candidate);
  }
  return out;
}

export interface CreatedLogin {
  username: string;
  password: string;
  email: string;
  auth_user_id: string;
}

/**
 * Create a tablet login for a restaurant, trying each candidate username
 * until one is free. Records the password (migration 026) so the CRM can
 * show it again, and audits `created` with the actor.
 */
export async function createLoginWithFreeUsername(
  restaurant: { id: string; name: string },
  candidates: string[],
  actor: string | null
): Promise<CreatedLogin> {
  const admin = supabaseAdmin();
  const password = generatePassword((n) => Uint8Array.from(randomBytes(n)));
  let lastError = "no username candidate was free";
  for (const username of candidates) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: usernameToEmail(username),
      password,
      email_confirm: true,
    });
    if (error || !created?.user) {
      const taken = /already|exists|registered/i.test(error?.message ?? "");
      if (taken) continue;
      throw new Error(error?.message || "could not create the login");
    }
    const { error: linkError } = await admin.from("restaurant_users").upsert(
      {
        restaurant_id: restaurant.id,
        auth_user_id: created.user.id,
        role: "staff",
        password_current: password,
        password_set_at: new Date().toISOString(),
      },
      { onConflict: "restaurant_id,auth_user_id" }
    );
    if (linkError) throw new Error(linkError.message);
    await admin
      .from("restaurant_login_audit")
      .insert({ restaurant_id: restaurant.id, username, action: "created", actor, note: `login created for ${restaurant.name} (provision)` })
      .then(({ error: auditError }) => {
        if (auditError) console.error("login audit not recorded:", auditError.message);
      });
    return { username, password, email: usernameToEmail(username), auth_user_id: created.user.id };
  }
  throw new Error(lastError);
}

export interface EnsuredLogin {
  username: string;
  /** The auth email the username maps to - what a magic link is generated for. */
  email: string;
  auth_user_id: string;
  /** Only when this call created it. Never the existing one. */
  password?: string;
  created: boolean;
}

/**
 * The restaurant's tablet login, found or made.
 *
 * A login exists if any staff link does. Never reset one: the password on
 * the wall is the one that works, and the CRM can reveal it if lost. Shared
 * by provisioning (E1) and by linking a code (I1) - two ways to arrive at
 * the same login, and one rule for which login that is.
 */
export async function ensureTabletLogin(
  restaurant: { id: string; name: string },
  actor: string | null
): Promise<EnsuredLogin> {
  const admin = supabaseAdmin();
  const { data: links } = await admin
    .from("restaurant_users")
    .select("auth_user_id, role, created_at")
    .eq("restaurant_id", restaurant.id)
    .order("created_at");
  if (links?.length) {
    // Name the oldest staff login, resolved through auth like the list route.
    const first = links[0];
    const { data: user } = await admin.auth.admin.getUserById(first.auth_user_id);
    const email = user?.user?.email ?? null;
    const username = email ? (email.split("@")[0] ?? email) : first.auth_user_id;
    return {
      username,
      email: email ?? usernameToEmail(username),
      auth_user_id: first.auth_user_id,
      created: false,
    };
  }
  const created = await createLoginWithFreeUsername(restaurant, usernameCandidates(restaurant.name), actor);
  return { ...created, created: true };
}

export interface ProvisionResult {
  restaurant: {
    id: string;
    name: string;
    is_active: boolean;
    app_expected: boolean;
    display_mode: string;
    timezone: string | null;
    crm_restaurant_id: string | null;
  };
  /** The existing login's username, or the new one. `password` only when newly created. */
  login: { username: string; password?: string; created: boolean } | null;
  printers: { id: string; name: string; is_active: boolean; last_seen_at: string | null }[];
  destinations: ReturnType<typeof orderDestinations>;
  /** What this call actually changed, so the CRM can say it. */
  changed: string[];
}

export async function provisionRestaurant(restaurantId: string, actor: string | null): Promise<ProvisionResult | null> {
  const admin = supabaseAdmin();
  const { data: r } = await admin
    .from("restaurants")
    .select("id, name, is_active, app_expected, display_mode, timezone, crm_restaurant_id, print_method")
    // Either id - the CRM's account id or ours (lib/restaurant-ref.ts).
    .or(restaurantRefFilter(restaurantId) ?? "id.eq.00000000-0000-0000-0000-000000000000")
    .limit(1)
    .maybeSingle();
  if (!r) return null;

  const changed: string[] = [];
  const updates: Record<string, unknown> = {};
  if (!r.is_active) {
    updates.is_active = true;
    changed.push("is_active");
  }
  if (!r.app_expected) {
    updates.app_expected = true;
    changed.push("app_expected");
  }
  if (Object.keys(updates).length) {
    const { error } = await admin.from("restaurants").update(updates).eq("id", r.id);
    if (error) throw new Error(error.message);
  }

  const ensured = await ensureTabletLogin({ id: r.id, name: r.name }, actor);
  const login: ProvisionResult["login"] = ensured.created
    ? { username: ensured.username, password: ensured.password, created: true }
    : { username: ensured.username, created: false };
  if (ensured.created) changed.push("login");

  const { data: devices } = await admin
    .from("print_devices")
    .select("id, name, is_active, last_seen_at")
    .eq("restaurant_id", r.id)
    .order("name");
  const printers = (devices ?? []) as ProvisionResult["printers"];

  return {
    restaurant: {
      id: r.id,
      name: r.name,
      is_active: true,
      app_expected: true,
      display_mode: r.display_mode ?? "kitchen",
      timezone: r.timezone ?? null,
      crm_restaurant_id: r.crm_restaurant_id ?? null,
    },
    login,
    printers,
    destinations: orderDestinations({
      print_method: r.print_method,
      app_expected: true,
      hasActivePrinter: printers.some((p) => p.is_active),
    }),
    changed,
  };
}
