import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isCurrentUserAdmin } from "@/lib/authz";
import {
  MIN_PASSWORD_LENGTH,
  generatePassword,
  isValidUsername,
  normaliseUsername,
  usernameToEmail,
} from "@/lib/usernames";

/**
 * POST /api/admin/restaurant-users
 * body: { restaurant_id, username, password?, role? }
 *
 * Creates a restaurant login and links it to a restaurant.
 *
 * Username and password, not an emailed link. A kitchen tablet is shared,
 * lives in kiosk mode, and has no inbox anybody is watching - so a magic link
 * meant hunting through email on a device locked to one app, at the moment
 * orders were arriving. The address Supabase needs is derived from the
 * username instead of collected from anyone, and never receives mail.
 *
 * The password is returned ONCE. Nothing can retrieve it afterwards; a
 * forgotten one is replaced with PATCH, not recovered.
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const restaurantId = body?.restaurant_id;
  const username = normaliseUsername(body?.username ?? "");

  if (!restaurantId || !username) {
    return NextResponse.json(
      { error: "restaurant_id and username are required" },
      { status: 400 }
    );
  }
  if (!isValidUsername(username)) {
    return NextResponse.json(
      {
        error:
          "username must be 2-31 characters, lowercase letters, numbers, dot, dash or underscore - no spaces",
      },
      { status: 400 }
    );
  }

  // Generated unless one was supplied. Generated is the better default: it is
  // readable off a screen, and it is not the restaurant's name again.
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

  // email_confirm: true because nothing will ever confirm it - the address is
  // derived and undeliverable by design. Without this the account is created
  // unconfirmed and can never sign in.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: usernameToEmail(username),
    password,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    // Supabase reports a taken address as a 422. Say which part is taken:
    // "already registered" about an address nobody typed is bewildering when
    // what you typed was a username.
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
    { restaurant_id: restaurantId, auth_user_id: created.user.id, role: body?.role || "staff" },
    { onConflict: "restaurant_id,auth_user_id" }
  );

  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    username,
    password,
    note: "Shown once. Write it down before closing this - nothing can retrieve it, and a forgotten password is replaced rather than recovered.",
  });
}

/**
 * PATCH /api/admin/restaurant-users  { username, password? }
 *
 * Sets a new password on an existing login.
 *
 * There is no "forgot password" for these accounts and there cannot be: the
 * address is derived and receives nothing, so no reset email could ever
 * arrive. An admin sets a new one and reads it to them, which for a shared
 * kitchen device is the honest flow rather than a broken imitation of a
 * personal one.
 */
export async function PATCH(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const username = normaliseUsername(body?.username ?? "");
  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
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
  const email = usernameToEmail(username);

  const { data: list } = await admin.auth.admin.listUsers();
  const user = list?.users.find((u: { email?: string }) => u.email === email);
  if (!user) {
    return NextResponse.json({ error: `no login found for "${username}"` }, { status: 404 });
  }

  const { error } = await admin.auth.admin.updateUserById(user.id, { password });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    username,
    password,
    note: "The old password stopped working immediately. Anyone already signed in stays signed in until their session expires.",
  });
}
