/**
 * Usernames for restaurant logins.
 *
 * Supabase Auth identifies a user by email address, and a kitchen does not
 * have one. A tablet is shared, it lives in kiosk mode, and a magic link
 * means somebody hunting through an inbox on a device locked to one app -
 * at the exact moment orders are arriving. So restaurants sign in with a
 * username and a password, and the email Supabase needs is derived from the
 * username rather than collected from anyone.
 *
 * These accounts NEVER receive mail. They are created with the address
 * pre-confirmed, and password sign-in sends nothing, so no message is ever
 * addressed to one of them.
 */

/**
 * The domain every derived address sits under.
 *
 * A constant, not configuration, and it must never change: the address IS the
 * account's identity in Supabase, so changing this orphans every restaurant
 * login at once with no way back except renaming each user by hand. A
 * subdomain PFD controls, so it can be null-routed and can never collide with
 * a real mailbox.
 */
export const USERNAME_DOMAIN = "tablet.pfdworks.com";

/**
 * What a username may be.
 *
 * Lowercase letters, digits, dot, dash and underscore. No spaces and no
 * capitals, because this gets typed on a tablet keyboard by someone in a
 * hurry, and "Swezeys" failing to match "swezeys" is a support call nobody
 * should have to make. Length capped so it stays readable on a login screen.
 */
const VALID = /^[a-z0-9][a-z0-9._-]{1,30}$/;

export function isValidUsername(value: string): boolean {
  return VALID.test(value);
}

/**
 * Normalises what somebody typed. Trimmed and lowercased, so the same login
 * works whichever way the tablet's keyboard decided to capitalise it.
 */
export function normaliseUsername(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The address Supabase stores for a username.
 *
 * An input that already contains "@" is passed through untouched: real email
 * accounts exist - PFD's own admins, and anyone who signed in before
 * usernames - and they must keep working. That check is why this is one
 * function rather than string concatenation at each call site.
 */
export function usernameToEmail(value: string): string {
  const v = normaliseUsername(value);
  return v.includes("@") ? v : `${v}@${USERNAME_DOMAIN}`;
}

/**
 * The username behind a derived address, or null for a real email.
 *
 * Used to show an admin who can sign in to a restaurant without displaying a
 * fake address that looks like somewhere you could send mail.
 */
export function emailToUsername(email: string): string | null {
  const v = normaliseUsername(email);
  const suffix = `@${USERNAME_DOMAIN}`;
  return v.endsWith(suffix) ? v.slice(0, -suffix.length) : null;
}

/** True when this address is a derived one rather than a real mailbox. */
export const isDerivedEmail = (email: string): boolean =>
  emailToUsername(email) !== null;

/**
 * A password that can be read off a screen and typed on a tablet.
 *
 * No l/1/I/O/0, for the same reason the device keys avoid them: these get
 * written on a sticky note and typed by someone who did not choose them.
 * Length over alphabet size - four words of five characters is stronger than
 * anything a kitchen would otherwise pick, and can be read aloud down a phone.
 */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generatePassword(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
  return [
    chars.slice(0, 5).join(""),
    chars.slice(5, 10).join(""),
    chars.slice(10, 15).join(""),
    chars.slice(15, 20).join(""),
  ].join("-");
}

/** Supabase's own floor. Stated here so the message can be ours. */
export const MIN_PASSWORD_LENGTH = 8;
