import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { authorizeCrmWrite } from "@/lib/crm-auth";
import { findRestaurantByRef } from "@/lib/restaurant-ref";
import { sendComposedEmail } from "@/lib/email-out";
import {
  composeOwnerLoginEmail,
  isAlreadyRegistered,
  parseOwnerEmail,
  setPasswordUrl,
  type OwnerLinkType,
} from "@/lib/owner-invite";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/crm/restaurants/:id/owner-invite   (either id; CRM_WRITE_KEY)
 *
 *   { email, actor?, preview? } -> { ok, email, type, sent, subject, messageId? }
 *
 * Emails a restaurant owner a "set your password" link for the partner
 * portal, from info@ (the gmail.send grant tickets and statements use).
 *
 *   - No account for the address yet: one is created by an invite link and
 *     linked to this restaurant as role 'owner'.
 *   - An account already exists: a recovery link instead, so sending again is
 *     how a lost password or an expired link is fixed. It is linked to this
 *     restaurant too if it was not already.
 *
 * The owner picks the password on /set-password. Nothing here sees, stores or
 * returns one, and the link itself is never returned to the caller either:
 * it goes to the owner's inbox and nowhere else.
 *
 * `preview: true` composes the email with a placeholder link and changes
 * nothing - no account, no link, no send - so the CRM can show the wording.
 *
 * Refused for a PFD admin's address: an admin's password is not something a
 * restaurant screen should be able to send a reset for.
 */

function portalBase(req: NextRequest): string {
  return process.env.PORTAL_BASE_URL || req.nextUrl.origin;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = authorizeCrmWrite(req);
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const body = (await req.json().catch(() => null)) ?? {};
  const parsed = parseOwnerEmail(body.email);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { email } = parsed;
  const actor =
    typeof body.actor === "string" && body.actor.trim() ? body.actor.trim().slice(0, 200) : null;

  const restaurant = await findRestaurantByRef<{ id: string; name: string }>(params.id, "id, name");
  if (!restaurant) return NextResponse.json({ error: "restaurant not found" }, { status: 404 });

  const base = portalBase(req);
  const loginUrl = new URL("/login", base).toString();

  if (body.preview === true) {
    const composed = composeOwnerLoginEmail({
      restaurantName: restaurant.name,
      link: setPasswordUrl(base, "PREVIEW-LINK-NOT-REAL", "invite"),
      loginUrl,
      email,
      type: "invite",
    });
    return NextResponse.json({ ok: true, preview: true, email, ...composed });
  }

  const admin = supabaseAdmin();
  const redirectTo = new URL("/dashboard", base).toString();

  // Invite first; an address that already has an account gets a recovery
  // link instead. Either way the owner lands on the same form.
  let type: OwnerLinkType = "invite";
  let link = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo } });
  if (link.error && isAlreadyRegistered(link.error.message)) {
    type = "recovery";
    link = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo } });
  }
  if (link.error || !link.data?.user || !link.data?.properties?.hashed_token) {
    return NextResponse.json(
      { error: `could not create a login link for ${email}: ${link.error?.message ?? "no token returned"}` },
      { status: 502 }
    );
  }
  const authUserId = link.data.user.id;

  const { data: isAdmin } = await admin.from("admins").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (isAdmin) {
    return NextResponse.json(
      { error: `${email} is a Premium admin account. Owner logins must be the restaurant's own address.` },
      { status: 409 }
    );
  }

  // Link to this restaurant. An existing link keeps its role: an address that
  // is already 'staff' here is not quietly promoted.
  const { error: linkError } = await admin
    .from("restaurant_users")
    .upsert(
      { restaurant_id: restaurant.id, auth_user_id: authUserId, role: "owner" },
      { onConflict: "restaurant_id,auth_user_id", ignoreDuplicates: true }
    );
  if (linkError) {
    return NextResponse.json(
      { error: `could not link ${email} to ${restaurant.name}: ${linkError.message}` },
      { status: 500 }
    );
  }

  // The owner is about to choose a password nobody here sees, so a copy kept
  // from an earlier "Set new password" in the CRM would soon be wrong. Shown
  // again, a wrong password is worse than none.
  const { error: clearError } = await admin
    .from("restaurant_users")
    .update({ password_current: null })
    .eq("restaurant_id", restaurant.id)
    .eq("auth_user_id", authUserId);
  if (clearError) console.error("stored password not cleared for", email, "-", clearError.message);

  const composed = composeOwnerLoginEmail({
    restaurantName: restaurant.name,
    link: setPasswordUrl(base, link.data.properties.hashed_token, type),
    loginUrl,
    email,
    type,
  });
  const sent = await sendComposedEmail(email, composed);

  // Never blocks the answer. Records that a login email went out and who
  // asked; never the link.
  const { error: auditError } = await admin.from("restaurant_login_audit").insert({
    restaurant_id: restaurant.id,
    username: email,
    action: type === "invite" ? "created" : "password_reset",
    actor,
    note: sent.ok
      ? `owner login email (${type}) sent to ${email}`
      : `owner login email (${type}) to ${email} FAILED: ${sent.error ?? "unknown"}`,
  });
  if (auditError) console.error("login audit NOT recorded", email, "-", auditError.message);

  if (!sent.ok) {
    return NextResponse.json(
      { error: `the login was set up but the email to ${email} did not send: ${sent.error}`, type, sent: false },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, email, type, sent: true, subject: composed.subject, messageId: sent.messageId });
}
