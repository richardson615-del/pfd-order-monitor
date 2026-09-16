/**
 * Linking a session-less tablet to a restaurant, without anybody typing a
 * credential on the tablet.
 *
 * The rule (Nick, 2026-09-16): the restaurant's only setup step is Wi-Fi.
 * A tablet that has connectivity but no valid session - never bound, or the
 * session was lost - shows a six-digit code and "Call Premium". The office
 * enters the code in the CRM against a restaurant, the bridge mints a
 * session for that device, and the tablet picks it up on its next poll.
 * Never a username or password field on the tablet again.
 *
 * Pure, like lib/kiosk.ts and for the same reason: these rules decide who
 * gets a session for whose orders, so they are worth asserting without a
 * database. The two routes under app/api/kiosk and the CRM route under
 * app/api/crm/tablets call these; none of them re-derive a rule.
 */

/** Six digits: readable over a phone line, in a kitchen, once. */
export const LINK_CODE_LENGTH = 6;

/**
 * Thirty minutes. Long enough for "call the office, wait on hold, read the
 * code out"; short enough that a code somebody wrote on a whiteboard is not
 * still live at the next shift. The tablet asks for a fresh one on expiry,
 * so nothing is lost by it being short.
 */
export const LINK_CODE_TTL_MS = 30 * 60_000;

/** How often the tablet asks whether the office has linked it yet. */
export const LINK_STATUS_POLL_MS = 5_000;

/**
 * Codes one address may create in a window. A tablet needs one every thirty
 * minutes; twenty in ten minutes is somebody's script, not somebody's
 * kitchen. Per address rather than per device because the device id is the
 * caller's to invent.
 */
export const LINK_CODE_RATE_WINDOW_MS = 10 * 60_000;
export const LINK_CODE_RATE_MAX = 20;

/** What the tablet sends as its device id: opaque, random, 16..64 url-safe characters. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && DEVICE_ID_PATTERN.test(value);

export const isLinkCode = (value: unknown): value is string =>
  typeof value === "string" && new RegExp(`^[0-9]{${LINK_CODE_LENGTH}}$`).test(value);

/**
 * A six-digit code from random bytes, uniform, zero-padded.
 *
 * Rejection sampling rather than `% 1_000_000` on three bytes: 16 777 216 is
 * not a multiple of a million, so a plain modulo would make the low codes
 * slightly likelier. Not a practical weakness at this size - but "slightly
 * biased" is a property somebody has to remember, and "uniform" is not.
 */
export function generateLinkCode(randomBytes: (n: number) => Uint8Array): string {
  const space = 10 ** LINK_CODE_LENGTH;
  const limit = Math.floor(2 ** 24 / space) * space;
  for (;;) {
    const b = randomBytes(3);
    const n = (b[0] << 16) | (b[1] << 8) | b[2];
    if (n < limit) return String(n % space).padStart(LINK_CODE_LENGTH, "0");
  }
}

export interface LinkCodeRow {
  code: string;
  device_id: string;
  expires_at: string;
  restaurant_id: string | null;
  linked_at: string | null;
  token_hash: string | null;
  consumed_at: string | null;
}

export type LinkCodeState =
  /** Shown on the tablet, nobody has linked it yet. */
  | "pending"
  /** The office linked it; the tablet has not collected the session yet. */
  | "linked"
  /** The tablet collected it. Nothing left to give. */
  | "consumed"
  /** Past its thirty minutes. The tablet asks for a new one. */
  | "expired";

/**
 * What a code is right now.
 *
 * Expiry is checked on the pending state only: a code the office linked at
 * minute 29 and the tablet collects at minute 31 is still a good link - the
 * thirty minutes is how long the office has to act, not how long the
 * tablet has to notice. The token itself has Supabase's own expiry.
 */
export function linkCodeState(row: Pick<LinkCodeRow, "expires_at" | "linked_at" | "consumed_at">, now: number): LinkCodeState {
  if (row.consumed_at) return "consumed";
  if (row.linked_at) return "linked";
  const exp = new Date(row.expires_at).getTime();
  if (Number.isNaN(exp) || now >= exp) return "expired";
  return "pending";
}

/**
 * Whether this address may create another code right now.
 * `recentCount` = codes it created inside LINK_CODE_RATE_WINDOW_MS.
 */
export const mayCreateLinkCode = (recentCount: number): boolean =>
  Number.isInteger(recentCount) && recentCount < LINK_CODE_RATE_MAX;

/**
 * Whether a device may collect the token on a row: it has to be the device
 * the code was issued to, the office has to have linked it, and nobody may
 * have collected it already. Anything else is a 404 to the caller - not a
 * 403 - because "that code exists but is not yours" is a favour to nobody
 * except someone guessing codes.
 */
export function mayCollect(row: LinkCodeRow, deviceId: string, now: number): boolean {
  if (row.device_id !== deviceId) return false;
  if (linkCodeState(row, now) !== "linked") return false;
  return typeof row.token_hash === "string" && row.token_hash.length > 0;
}

/**
 * The magic-link hash Supabase hands back from generateLink, or null when
 * the shape is not what we expect. Checked rather than trusted: this is the
 * one string that becomes a session, and handing the tablet `undefined`
 * would leave it polling forever with the office believing it is done.
 */
export function tokenHashFrom(generated: unknown): string | null {
  const props = (generated as { properties?: { hashed_token?: unknown } } | null)?.properties;
  const hash = props?.hashed_token;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}
