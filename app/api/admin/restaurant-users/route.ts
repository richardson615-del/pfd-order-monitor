import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isCurrentUserAdmin } from "@/lib/authz";

/**
 * POST /api/admin/restaurant-users
 * body: { restaurant_id, email, role? }
 * Invites (or reuses) a Supabase Auth user by email and links them to a
 * restaurant so they can log in to the dashboard. Sends a magic-link email.
 */
export async function POST(req: NextRequest) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { restaurant_id, email, role } = await req.json();
  if (!restaurant_id || !email) {
    return NextResponse.json(
      { error: "restaurant_id and email are required" },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  // inviteUserByEmail creates the auth user (if new) and emails them a link
  // to set a password / sign in. If the user already exists this returns an
  // error we can safely ignore and look the user up instead.
  let authUserId: string | null = null;
  const { data: invited, error: inviteError } =
    await admin.auth.admin.inviteUserByEmail(email);

  if (invited?.user) {
    authUserId = invited.user.id;
  } else {
    const { data: list } = await admin.auth.admin.listUsers();
    const existing = list?.users.find((u: { email?: string }) => u.email === email);
    if (existing) authUserId = existing.id;
  }

  if (!authUserId) {
    return NextResponse.json(
      { error: inviteError?.message || "could not create or find user" },
      { status: 400 }
    );
  }

  const { error } = await admin.from("restaurant_users").upsert(
    { restaurant_id, auth_user_id: authUserId, role: role || "staff" },
    { onConflict: "restaurant_id,auth_user_id" }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
