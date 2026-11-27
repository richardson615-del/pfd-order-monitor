import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { isDeviceSecret, isSecretHash } from "@/lib/device-binding";

/**
 * The server half of the device secret (SH1 / Z-02). Rules and the reasons
 * for them: lib/device-binding.ts. This file exists only because that one
 * is imported by the Pairing page and cannot pull in node:crypto.
 *
 * Nothing here logs, and nothing here returns a stored hash to a caller.
 */

/** 32 random bytes as 43 url-safe characters. Handed to the tablet once; only its hash is kept. */
export function newDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 of the secret's text, lowercase hex: what kiosk_devices.secret_hash holds and what the CRM sends. */
export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Does this presented secret belong to a row with this stored hash?
 *
 * False for anything that is not a well-formed secret against a well-formed
 * hash - a missing secret, a row with no hash, a hash that is not 64 hex
 * characters - so every odd case fails closed. The comparison itself is
 * constant-time over the two digests.
 */
export function deviceSecretMatches(storedHash: string | null | undefined, presented: unknown): boolean {
  if (!isSecretHash(storedHash) || !isDeviceSecret(presented)) return false;
  const a = Buffer.from(storedHash, "hex");
  const b = Buffer.from(hashDeviceSecret(presented), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
