import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Authentication for the CRM management bridge.
 *
 * This is a WRITE-scoped surface: it can deactivate a printer, move one to a
 * different restaurant, and mint device keys. That is a strictly larger blast
 * radius than the read bridge, so it gets its own key - sharing one would mean
 * anything holding the read key could silently stop a restaurant printing.
 */

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, and length is not the secret.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Minimum key length. A write key guessable by brute force is not a key. */
export const MIN_CRM_KEY_LENGTH = 32;

export interface CrmAuthFailure {
  error: string;
  status: number;
}

/**
 * Returns null when the caller is authorised, or the failure to return.
 *
 * Misconfiguration answers 503, not 401: "you are not allowed in" and "nobody
 * can get in because the key was never set" are different problems, and
 * conflating them is how a dead integration gets debugged as a bad credential.
 */
export function authorizeCrmWrite(req: NextRequest): CrmAuthFailure | null {
  const expected = process.env.CRM_WRITE_KEY;
  if (!expected) {
    return { error: "CRM_WRITE_KEY is not set - the write bridge is disabled", status: 503 };
  }
  if (expected.length < MIN_CRM_KEY_LENGTH) {
    return {
      error: `CRM_WRITE_KEY is shorter than ${MIN_CRM_KEY_LENGTH} characters`,
      status: 503,
    };
  }
  // Catch the copy-paste that would quietly collapse two scopes into one.
  const readKey = process.env.CRM_STATUS_READ_KEY;
  if (readKey && constantTimeEquals(expected, readKey)) {
    return {
      error: "CRM_WRITE_KEY must not equal CRM_STATUS_READ_KEY",
      status: 503,
    };
  }

  const presented = (req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!presented || !constantTimeEquals(presented, expected)) {
    return { error: "unauthorized", status: 401 };
  }
  return null;
}
