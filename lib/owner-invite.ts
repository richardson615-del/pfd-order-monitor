/**
 * Owner login emails for the partner portal (2026-11-02, Nick: "we send them
 * an email hey log in here and it prompts them to submit a new password").
 *
 * An OWNER login is not the tablet login. The tablet signs in with a username
 * whose address is derived and receives nothing (lib/usernames.ts), and its
 * password is kept so the office can read it back to a kitchen. An owner
 * login is the owner's own real email address, linked to the restaurant with
 * role 'owner', and the owner chooses the password. Nobody at Premium ever
 * sees it, so this flow never stores one.
 *
 * The emailed link carries a Supabase token_hash, not the action_link that
 * generateLink also returns. The difference is the whole design: the
 * action_link is consumed by the first GET to it, so a mail scanner that
 * follows links burns it before the owner clicks (the CRM met exactly this,
 * see prs-crm accept-invite). /set-password only shows a form on GET; the
 * token is spent by verifyOtp when the owner presses the button.
 *
 * Pure: no network, no database. The route does the work.
 */

import { USERNAME_DOMAIN, normaliseUsername } from "./usernames";

export type OwnerLinkType = "invite" | "recovery";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A real address an owner can receive mail at, or an error to show. */
export function parseOwnerEmail(raw: unknown): { email: string } | { error: string } {
  const email = normaliseUsername(String(raw ?? ""));
  if (!email || !EMAIL.test(email)) return { error: "`email` must be a valid email address" };
  // A derived tablet address receives nothing, so a link sent there is a
  // link nobody will ever open.
  if (email.endsWith(`@${USERNAME_DOMAIN}`)) {
    return { error: `${email} is a tablet login, not a mailbox. Use the owner's own email address.` };
  }
  if (email.length > 200) return { error: "`email` is too long" };
  return { email };
}

/** Supabase says this when inviting an address that already has an account. */
export function isAlreadyRegistered(message: string | undefined | null): boolean {
  return /already\s+(been\s+)?registered|already exists/i.test(String(message ?? ""));
}

/** The page the email opens. token_hash travels in the query, never a fragment. */
export function setPasswordUrl(base: string, tokenHash: string, type: OwnerLinkType): string {
  const url = new URL("/set-password", base);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", type);
  return url.toString();
}

/** What /set-password accepts back from its own query string. */
export function parseSetPasswordParams(
  params: { get(name: string): string | null }
): { tokenHash: string; type: OwnerLinkType } | null {
  const tokenHash = (params.get("token_hash") ?? "").trim();
  const type = params.get("type");
  if (!tokenHash || !/^[A-Za-z0-9_-]{16,200}$/.test(tokenHash)) return null;
  if (type !== "invite" && type !== "recovery") return null;
  return { tokenHash, type };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface OwnerEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The email itself. Plain and short: who it is from, what the login is for,
 * one button, and what to do if the link has stopped working.
 */
export function composeOwnerLoginEmail(input: {
  restaurantName: string;
  link: string;
  loginUrl: string;
  email: string;
  type: OwnerLinkType;
}): OwnerEmail {
  const name = input.restaurantName.trim() || "your restaurant";
  const subject =
    input.type === "invite"
      ? `Your Premium login for ${name}`
      : `Set a new password for your Premium login`;
  const lead =
    input.type === "invite"
      ? `We've set up your own login for ${name}, so you can see your statements, orders, menu and store settings anytime.`
      : `Here's a link to set a new password for your ${name} login.`;

  const text = [
    "Hello,",
    "",
    lead,
    "",
    "Open this link to choose your password:",
    input.link,
    "",
    `After that, sign in at ${input.loginUrl} with ${input.email} and your new password.`,
    "",
    "The link works once and expires. If it has stopped working, go to the sign-in page and choose \"Sign in with an email link instead\", or reply to this email and we'll send a new one.",
    "",
    "Thank you,",
    "Premium Food Delivery",
  ].join("\n");

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    `<p>Hello,</p>` +
    `<p>${escapeHtml(lead)}</p>` +
    `<p><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#111;color:#fff;` +
    `padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Set my password</a></p>` +
    `<p>After that, sign in at <a href="${escapeHtml(input.loginUrl)}">${escapeHtml(input.loginUrl)}</a> ` +
    `with ${escapeHtml(input.email)} and your new password.</p>` +
    `<p style="color:#555;font-size:13px">The link works once and expires. If it has stopped working, ` +
    `go to the sign-in page and choose "Sign in with an email link instead", or reply to this email and we'll send a new one.</p>` +
    `<p>Thank you,<br>Premium Food Delivery</p>` +
    `</div>`;

  return { subject, html, text };
}
