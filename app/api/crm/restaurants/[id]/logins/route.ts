import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import {
  MIN_PASSWORD_LENGTH,
  emailToUsername,
  generatePassword,
  isValidUsername,
  normaliseUsername,
  usernameToEmail,
} from "@/lib/usernames";

export const dynamic = "force-dynamic";

/**
 * Restaurant logins, over the bridge.
 *
 * These existed only in this app's own admin panel, which meant onboarding a
 * restaurant was four things in the CRM and then a jump to a different system
 * for the fifth - the one that decides whether anybody can actually sign in
 * to the tablet.
 *
 *   GET    - who can sign in to this restaurant
 *   GET ?reveal=<username>  - show that login's password again
 *   POST   - create a login          { username, actor? }
 *   PATCH  - set a new password      { username, actor? }
 *
 * The password used to be shown once and then be gone, recoverable only by
 * resetting it. Migration 026 changed that deliberately: it is now stored and
 * can be shown again. The reasoning is in that migration - briefly, these
 * guard a restaurant's own order screen, and a password nobody can look up
 * means a reset every time a tablet is replaced, which is a phone call during
 * service.
 *
 * Reveal is its own request rather than a field on the list, so that opening
 * the panel to see WHO can sign in does not read a credential, and so the
 * audit row means something. Same shape as the printer device key reveal.
 *
 * Every write and every reveal is audited (migrations 023 and 026), the same
 * judgement migration 015 made about device keys: a credential that can be
 * read is one worth recording who read. The bridge authenticates with a
 * single shared key and cannot know who asked, so the CRM passes `actor` and
 * an absent one is recorded as null rather than guessed at.
 */

/** Never blocks the write. An unwritable audit row is a problem to shout
 *  about, not a reason to leave somebody unable to sign a tablet in. */
async function audit(entry: {
  restaurantId: string;
  username: string;
  action: "created" | "password_reset" | "password_shown";
  actor: string | null;
  note?: string;
}) {
  try {
    const { error } = await supabaseAdmin().from("restaurant_login_audit").insert({
      restaurant_id: entry.restaurantId,
      username: entry.username,
      action: entry.action,
      actor: entry.actor,
      note: entry.note ?? null,
    });
    if (error) {
      console.error("login audit NOT recorded", entry.action, entry.username, "-", error.message);
    }
  } catch (err) {
    console.error(
      "login audit NOT recorded",
      entry.action,
      entry.username,
      "-",
      err instanceof Error ? err.message : err
    );
  }
}

const actorOf = (body: any): string | null =>
  typeof body?.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;

async function findRestaurant(id: string) {
  const { data } = await supabaseAdmin()
    .from("restaurants")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  return data;
}

/**
 * The link row for one username within one restaurant, or null.
 *
 * Scoped to the restaurant on purpose, and shared by reveal and PATCH so the
 * two cannot drift: a restaurant-scoped route must not act on a login that
 * belongs to somebody else just because the username was spelled right.
 */
async function findLink(restaurantId: string, username: string) {
  const admin = supabaseAdmin();
  const email = usernameToEmail(username);

  const { data: links } = await admin
    .from("restaurant_users")
    .select("auth_user_id, password_current")
    .eq("restaurant_id", restaurantId);

  for (const link of links ?? []) {
    const { data } = await admin.auth.admin.getUserById(link.auth_user_id);
    if (data?.user?.email === email) return link;
  }
  return null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const restaurant = await findRestaurant(params.id);
  if (!restaurant) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  // --- reveal one password -------------------------------------------------
  // A separate request from listing, so that opening the panel to see who can
  // sign in does not read a credential and does not write an audit row. The
  // actor rides in a header here because a GET has no body.
  const reveal = normaliseUsername(req.nextUrl.searchParams.get("reveal") ?? "");
  if (reveal) {
    const link = await findLink(restaurant.id, reveal);
    if (!link) {
      return NextResponse.json(
        { error: `"${reveal}" is not a login for ${restaurant.name}` },
        { status: 404 }
      );
    }
    if (!link.password_current) {
      // Created before migration 026, so the only copy is Supabase's hash.
      return NextResponse.json(
        {
          error: `"${reveal}" was created before passwords were kept, so there is nothing to show. Reset it to get a new one.`,
          resettable: true,
        },
        { status: 409 }
      );
    }

    await audit({
      restaurantId: restaurant.id,
      username: reveal,
      action: "password_shown",
      actor: actorOf({ actor: req.headers.get("x-crm-actor") }),
      note: `password shown for ${restaurant.name}`,
    });

    return NextResponse.json({ ok: true, username: reveal, password: link.password_current });
  }

  const { data: links } = await admin
    .from("restaurant_users")
    .select("auth_user_id, role, created_at, password_current")
    .eq("restaurant_id", restaurant.id);

  // getUserById per link rather than listUsers(): listUsers pages at 50 and
  // would silently omit logins once this database grows, which for a screen
  // answering "who can sign in here" is the worst possible way to be wrong.
  const logins = [];
  for (const link of links ?? []) {
    const { data } = await admin.auth.admin.getUserById(link.auth_user_id);
    const email = data?.user?.email ?? "";
    if (!email) continue;
    logins.push({
      username: emailToUsername(email) ?? email,
      // A real address means an older, email-link account. Worth showing as
      // what it is rather than dressing it up as a username.
      is_email_login: emailToUsername(email) === null,
      role: link.role,
      created_at: link.created_at,
      // Whether there is anything to reveal, so the CRM can show a working
      // button or explain why it cannot - without the list itself carrying
      // the password.
      has_password: Boolean(link.password_current),
    });
  }

  return NextResponse.json({ restaurant: { id: restaurant.id, name: restaurant.name }, logins });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const username = normaliseUsername(body?.username ?? "");
  const actor = actorOf(body);

  const restaurant = await findRestaurant(params.id);
  if (!restaurant) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  if (!isValidUsername(username)) {
    return NextResponse.json(
      {
        error:
          "username must be 2-31 characters, lowercase letters, numbers, dot, dash or underscore - no spaces",
      },
      { status: 400 }
    );
  }

  const password =
    typeof body?.password === "string" && body.password.length
      ? body.password
      : generatePassword((n) => Uint8Array.from(randomBytes(n)));

  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  // email_confirm because nothing will ever confirm it - the address is
  // derived and undeliverable by design. Without it the account is created
  // unconfirmed and can never sign in.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: usernameToEmail(username),
    password,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    const taken = /already|exists|registered/i.test(createError?.message ?? "");
    return NextResponse.json(
      {
        error: taken
          ? `the username "${username}" is already taken - pick another, or set a new password on the existing login`
          : createError?.message || "could not create the login",
      },
      { status: taken ? 409 : 400 }
    );
  }

  const { error: linkError } = await admin.from("restaurant_users").upsert(
    {
      restaurant_id: restaurant.id,
      auth_user_id: created.user.id,
      role: "staff",
      // Kept so the CRM can show it again - migration 026.
      password_current: password,
      password_set_at: new Date().toISOString(),
    },
    { onConflict: "restaurant_id,auth_user_id" }
  );
  if (linkError) return NextResponse.json({ error: linkError.message }, { status: 400 });

  await audit({
    restaurantId: restaurant.id,
    username,
    action: "created",
    actor,
    note: `login created for ${restaurant.name}`,
  });

  return NextResponse.json({
    ok: true,
    username,
    password,
    audited: true,
    note: "Write it down for the tablet. If it gets lost, the CRM can show it again - you do not have to reset it.",
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => null);
  const username = normaliseUsername(body?.username ?? "");
  const actor = actorOf(body);

  const restaurant = await findRestaurant(params.id);
  if (!restaurant) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });
  if (!username) return NextResponse.json({ error: "username is required" }, { status: 400 });

  const password =
    typeof body?.password === "string" && body.password.length
      ? body.password
      : generatePassword((n) => Uint8Array.from(randomBytes(n)));

  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  // Confirm the login actually belongs to THIS restaurant before touching it.
  // Without this check a restaurant-scoped route would happily reset any
  // login in the system given its username, which is not what the URL says
  // it does and not what an audit row would then describe.
  const link = await findLink(restaurant.id, username);
  if (!link) {
    return NextResponse.json(
      { error: `"${username}" is not a login for ${restaurant.name}` },
      { status: 404 }
    );
  }

  const { error } = await admin.auth.admin.updateUserById(link.auth_user_id, { password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Only after Supabase accepted it. Storing first would leave the CRM
  // showing a password that does not work, which is worse than showing none.
  const { error: storeError } = await admin
    .from("restaurant_users")
    .update({ password_current: password, password_set_at: new Date().toISOString() })
    .eq("restaurant_id", restaurant.id)
    .eq("auth_user_id", link.auth_user_id);
  if (storeError) {
    // The password IS changed and is in this response - failing the request
    // now would tell the caller it did not work when it did.
    console.error("login password not stored for", username, "-", storeError.message);
  }

  await audit({
    restaurantId: restaurant.id,
    username,
    action: "password_reset",
    actor,
    note: `password reset for ${restaurant.name}`,
  });

  return NextResponse.json({
    ok: true,
    username,
    password,
    audited: true,
    // The consequence, stated: a tablet already signed in keeps working, so
    // resetting does not fix a tablet that is currently stuck.
    note: "The old password stopped working immediately. A tablet already signed in stays signed in until its session ends. This one can be shown again from the CRM.",
  });
}
