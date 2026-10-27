/**
 * PFD Partner, the restaurant owner's phone app (PA1, 2026-10-26).
 *
 * Matt: "any restaurant owner can put on their phone and login ... send us
 * trouble tickets and communicate with dispatch". The app is a front door
 * onto what the tablet already does (/api/dashboard/*): the dispatch thread,
 * the Store tab, statements, menu changes. It signs in as the restaurant's
 * own login, two ways (Matt's pick, "both"):
 *
 *   - a 6-digit code texted to an owner's cell the CRM put on file
 *     (app_owner_phones, migration 054), or
 *   - the restaurant's username and password.
 *
 * Either way the app gets an ordinary Supabase session (access + refresh
 * token) and sends `Authorization: Bearer <access>`; supabaseServer() then
 * acts as that login, so every dashboard route and RLS policy is unchanged.
 *
 * Pure: the rules about phones and codes, asserted in
 * scripts/test-partner-app.ts. lib/partner-app-server.ts does the I/O.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Six digits, readable off a lock screen. */
export const LOGIN_CODE_LENGTH = 6;
/** Ten minutes from the text to the tap. */
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses before a code is spent. */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** Codes one phone may ask for in a window. */
export const LOGIN_CODE_RATE_MAX = 3;
export const LOGIN_CODE_RATE_WINDOW_MS = 10 * 60_000;

/**
 * A US cell in E.164, or null. Accepts what people type: (615) 555-0100,
 * 615.555.0100, +1 615 555 0100, 16155550100. Anything else is null, never a
 * guess.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/** The last four digits, for messages and logs. Never the whole number in a log. */
export const phoneTail = (e164: string): string => e164.slice(-4);

/** A uniformly random 6-digit code from the given random bytes (crypto.randomBytes in the server). */
export function newLoginCode(randomBytes: (n: number) => Uint8Array): string {
  // Rejection sampling over 3 bytes keeps every code equally likely.
  for (;;) {
    const b = randomBytes(3);
    const n = (b[0]! << 16) | (b[1]! << 8) | b[2]!;
    if (n < 16_000_000) return String(n % 1_000_000).padStart(LOGIN_CODE_LENGTH, "0");
  }
}

/** What is stored: a hash of the phone and code with a server secret, never the code. */
export function hashLoginCode(phone: string, code: string, secret: string): string {
  return createHash("sha256").update(`${secret}|${phone}|${code}`).digest("hex");
}

export function codesMatch(storedHash: string, phone: string, code: string, secret: string): boolean {
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(hashLoginCode(phone, code, secret), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const isWellFormedCode = (v: unknown): v is string => typeof v === "string" && /^\d{6}$/.test(v.trim());

export type CodeCheck = "ok" | "expired" | "used" | "too_many_tries" | "wrong";

/** Whether a stored code row may still be redeemed (before comparing the code itself). */
export function codeRowState(row: { expires_at: string; used_at: string | null; attempts: number }, now: number): Exclude<CodeCheck, "wrong" | "ok"> | null {
  if (row.used_at) return "used";
  if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return "too_many_tries";
  if (new Date(row.expires_at).getTime() <= now) return "expired";
  return null;
}

/** Words the app shows; the same for every failure that should not tell a stranger whether a phone is on file. */
export const CODE_FAILURE_WORDS: Record<Exclude<CodeCheck, "ok">, string> = {
  expired: "That code has expired. Ask for a new one.",
  used: "That code was already used. Ask for a new one.",
  too_many_tries: "Too many tries. Ask for a new code.",
  wrong: "That code isn't right. Check the text and try again.",
};

/** The SMS. Short, plain, and it says what it is for. */
export const loginCodeText = (code: string): string => `${code} is your PFD Partner sign-in code. It expires in 10 minutes.`;

/** `Authorization: Bearer <token>` -> token, else null. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec((header ?? "").trim());
  return m ? m[1]! : null;
}

/** An Expo push token, as expo-notifications returns it. */
export const isExpoPushToken = (v: unknown): v is string =>
  typeof v === "string" && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(v);

/** The name a dispatcher sees on the ticket: the owner's, trimmed, or null. */
export function cleanOwnerName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim().slice(0, 80);
  return t || null;
}

/** The owner-phones list the CRM sends: [{ phone, name? }], at most 10, deduplicated. */
export function parseOwnerPhones(input: unknown): { ok: true; phones: Array<{ phone: string; name: string | null }> } | { ok: false; error: string } {
  const list = (input as { phones?: unknown })?.phones;
  if (!Array.isArray(list)) return { ok: false, error: "phones must be a list" };
  if (list.length > 10) return { ok: false, error: "at most 10 phones per restaurant" };
  const seen = new Set<string>();
  const phones: Array<{ phone: string; name: string | null }> = [];
  for (const item of list) {
    const phone = normalizePhone((item as { phone?: unknown })?.phone);
    if (!phone) return { ok: false, error: "every phone must be a US number" };
    if (seen.has(phone)) continue;
    seen.add(phone);
    phones.push({ phone, name: cleanOwnerName((item as { name?: unknown })?.name) });
  }
  return { ok: true, phones };
}
