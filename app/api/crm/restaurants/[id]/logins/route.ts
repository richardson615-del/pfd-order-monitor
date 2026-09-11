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
 *   POST   - create a login          { username, actor? }
 *   PATCH  - set a new password      { username, actor? }
 *
 * Both writes return the password ONCE. Nothing retrieves it afterwards: a
 * forgotten one is replaced, not recovered, because the address behind these
 * accounts is derived and receives no mail, so no reset email could ever
 * arrive.
 *
 * Every write is audited (migration 023), the same judgement migration 015
 * made about printer device keys: a credential that can be read is one worth
 * recording who read. The bridge authenticates with a single shared key and
 * cannot know who asked, so the CRM passes `actor` and an absent one is
 * recorded as null rather than guessed at.
 */

/** Never blocks the write. An unwritable audit row is a problem to shout
 *  about, not a reason to leave somebody unable to sign a tablet in. */
async function audit(entry: {
  restaurantId: string;
  username: string;
  action: "created" | "password_reset";
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

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const admin = supabaseAdmin();
  const restaurant = await findRestaurant(params.id);
  if (!restaurant) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  const { data: links } = await admin
    .from("restaurant_users")
    .select("auth_user_id, role, created_at")
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
    { restaurant_id: restaurant.id, auth_user_id: created.user.id, role: "staff" },
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
    note: "Shown once. Nothing can retrieve it - a forgotten password is replaced, not recovered.",
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
  const email = usernameToEmail(username);

  // Confirm the login actually belongs to THIS restaurant before touching it.
  // Without this check a restaurant-scoped route would happily reset any
  // login in the system given its username, which is not what the URL says
  // it does and not what an audit row would then describe.
  const { data: links } = await admin
    .from("restaurant_users")
    .select("auth_user_id")
    .eq("restaurant_id", restaurant.id);

  let userId: string | null = null;
  for (const link of links ?? []) {
    const { data } = await admin.auth.admin.getUserById(link.auth_user_id);
    if (data?.user?.email === email) {
      userId = link.auth_user_id;
      break;
    }
  }

  if (!userId) {
    return NextResponse.json(
      { error: `"${username}" is not a login for ${restaurant.name}` },
      { status: 404 }
    );
  }

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

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
    note: "The old password stopped working immediately. A tablet already signed in stays signed in until its session ends.",
  });
}
