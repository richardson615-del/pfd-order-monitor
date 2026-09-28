import { createHmac } from "crypto";
import { constantTimeEquals } from "./crm-auth";

/**
 * ezCater's webhook signature, exactly as documented at
 * https://api.ezcater.io/subscription-create (read 2026-09-28):
 *
 *   header  X-Ezcater-Signature: "<timestamp>.<signature>"
 *   signed  [timestamp.to_i, request.body].join(".")
 *   hmac    OpenSSL::HMAC.hexdigest("sha256", webhook_secret, payload)
 *   check   "Compare your computed signature against the value after the
 *            period in the X-Ezcater-Signature header."
 *
 * Nothing else is documented - no tolerance window, no retry policy. So no
 * age limit is enforced here: a validly signed notification replayed late
 * only makes us re-fetch the order as it is NOW, which the ingest treats
 * idempotently. The age is returned so the route can log it.
 */

export type EzCaterSignatureResult =
  | { ok: true; timestamp: number; ageSeconds: number | null }
  | { ok: false; reason: "no_secret" | "no_header" | "malformed_header" | "mismatch" };

export function verifyEzCaterSignature(
  header: string | null | undefined,
  rawBody: string,
  secret: string | null | undefined,
  now: Date = new Date()
): EzCaterSignatureResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header || !header.trim()) return { ok: false, reason: "no_header" };
  const value = header.trim();
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { ok: false, reason: "malformed_header" };
  const timestampText = value.slice(0, dot);
  const presented = value.slice(dot + 1);
  // Ruby's to_i: the leading integer. A header whose timestamp has no digits is malformed.
  const match = /^\s*(-?\d+)/.exec(timestampText);
  if (!match) return { ok: false, reason: "malformed_header" };
  const timestamp = parseInt(match[1], 10);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  if (!constantTimeEquals(presented.toLowerCase(), expected)) return { ok: false, reason: "mismatch" };
  // Unix seconds is what `to_i` of a time gives; if ezCater ever sends
  // milliseconds the age is simply not reported rather than mis-reported.
  const ageSeconds = timestamp > 1e12 ? null : Math.round(now.getTime() / 1000 - timestamp);
  return { ok: true, timestamp, ageSeconds };
}

/** For tests: sign a body the way ezCater does. */
export function signEzCaterBody(rawBody: string, secret: string, timestamp: number): string {
  return `${timestamp}.${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}
