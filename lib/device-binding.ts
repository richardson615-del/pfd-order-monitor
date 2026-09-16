/**
 * A tablet boots straight into its restaurant (Workstream I1, 1b).
 *
 * The shell (android/) hands the page a device reference on the start URL:
 * `?device=<ref>`. The reference is either the serial Hexnode pushed via
 * managed app configuration (`device_ref`, res/xml/app_restrictions.xml)
 * or, when no configuration is present, the install's ANDROID_ID prefixed
 * "aid:". The app never reads the hardware serial itself - Android 10+
 * does not let it - and never invents one.
 *
 * On boot the page asks the bridge to bootstrap that reference. Bound: it
 * gets a magic-link hash for the restaurant's tablet login and verifies it
 * in the browser, which sets the session. Unbound: the reference is
 * recorded so the office can assign it, the page shows the link code (1c)
 * as well, and keeps asking every few seconds - so the office's one click
 * lands without a reboot.
 *
 * Pure, like lib/link-code.ts, and for the same reason: these rules hand
 * out sessions for a restaurant's orders.
 */

/**
 * What a device reference may look like: printable, no whitespace, short.
 * Hexnode serials are alphanumeric; ANDROID_ID is 16 hex characters and
 * arrives as "aid:<hex>". Anything else is refused before it is stored.
 */
export const DEVICE_REF_PATTERN = /^[A-Za-z0-9:._-]{4,128}$/;

export const isDeviceRef = (value: unknown): value is string =>
  typeof value === "string" && DEVICE_REF_PATTERN.test(value);

export type DeviceRefKind = "managed" | "android_id";

/** "aid:" marks a self-registered id (1b-ii); everything else came from managed configuration (1b-i). */
export const deviceRefKind = (ref: string): DeviceRefKind => (ref.startsWith("aid:") ? "android_id" : "managed");

/** The query parameter the shell appends to the start URL. */
export const DEVICE_PARAM = "device";

/** Read `?device=` off a URL; null when absent or malformed. */
export function readDeviceRef(url: string): string | null {
  try {
    const v = new URL(url).searchParams.get(DEVICE_PARAM);
    return isDeviceRef(v) ? v : null;
  } catch {
    return null;
  }
}

/** How often an unbound tablet asks again. The office's click should land within one of these. */
export const BOOTSTRAP_POLL_MS = 5_000;

/**
 * A bound device gets at most one session minted per this interval. A
 * tablet boots once; a page reloading in a loop, or a script replaying a
 * captured reference, does not get a fresh session each time. Polls that
 * arrive sooner are answered `throttled`, which the page treats exactly
 * like "try again in a moment".
 */
export const BOOTSTRAP_MINT_MIN_INTERVAL_MS = 30_000;

/** Bootstrap calls one address may make in a window - unbound tablets poll, so this is generous. */
export const BOOTSTRAP_RATE_WINDOW_MS = 10 * 60_000;
export const BOOTSTRAP_RATE_MAX = 300;

export interface KioskDeviceRow {
  device_ref: string;
  restaurant_id: string | null;
  last_bootstrap_at: string | null;
}

export type BootstrapDecision = "bound" | "unbound" | "throttled";

/**
 * What to do with a bootstrap for a known row (null = never seen).
 * Unbound is answered every time - it is what tells the tablet to keep
 * waiting - and costs nothing. Bound mints a session, so it is throttled.
 */
export function bootstrapDecision(row: KioskDeviceRow | null, now: number): BootstrapDecision {
  if (!row || !row.restaurant_id) return "unbound";
  if (row.last_bootstrap_at) {
    const t = new Date(row.last_bootstrap_at).getTime();
    if (!Number.isNaN(t) && now - t < BOOTSTRAP_MINT_MIN_INTERVAL_MS) return "throttled";
  }
  return "bound";
}

export const mayBootstrap = (recentCount: number): boolean =>
  Number.isInteger(recentCount) && recentCount < BOOTSTRAP_RATE_MAX;

/**
 * One binding as the CRM pushes it. restaurant_id null = unbind (the unit
 * went back to stock or to repair). The CRM sends the whole current map
 * after an MDM sync and single entries on assign/unassign; the bridge
 * upserts either way, so the two cannot disagree for long.
 */
export interface BindingInput {
  device_ref: string;
  restaurant_id: string | null;
  model?: string | null;
}

export function parseBindings(body: unknown): BindingInput[] | null {
  const list = Array.isArray((body as { bindings?: unknown })?.bindings)
    ? (body as { bindings: unknown[] }).bindings
    : body && typeof body === "object" && "device_ref" in (body as object)
      ? [body]
      : null;
  if (!list) return null;
  const out: BindingInput[] = [];
  for (const b of list) {
    const ref = (b as { device_ref?: unknown })?.device_ref;
    const rid = (b as { restaurant_id?: unknown })?.restaurant_id;
    const model = (b as { model?: unknown })?.model;
    if (!isDeviceRef(ref)) return null;
    if (rid !== null && rid !== undefined && typeof rid !== "string") return null;
    out.push({ device_ref: ref, restaurant_id: typeof rid === "string" && rid ? rid : null, model: typeof model === "string" ? model.slice(0, 120) : null });
  }
  return out;
}

/** How long a never-assigned reference stays on the CRM's "new tablets seen" list. */
export const UNBOUND_VISIBLE_MS = 7 * 24 * 3600_000;
