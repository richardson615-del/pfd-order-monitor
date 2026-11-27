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
  /** sha256 hex of the device secret (migration 067); null or absent = none set. Never the secret. */
  secret_hash?: string | null;
}

export type BootstrapDecision = "bound" | "unbound" | "throttled";

/**
 * The device secret (SH1 / Z-02).
 *
 * A device reference is not a secret: the serial is printed on the tablet
 * and shown in the CRM, and bootstrap is unauthenticated. So a reference
 * alone must not be worth a restaurant's session. A tablet also holds a
 * secret - 32 random bytes, sent as url-safe text - and the bridge keeps
 * only its sha256 (kiosk_devices.secret_hash).
 *
 * This file stays free of node:crypto because the Pairing page imports it;
 * hashing and the timing-safe comparison live in lib/device-secret.ts, and
 * the route hands the yes/no in here.
 */
export const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export const isDeviceSecret = (value: unknown): value is string =>
  typeof value === "string" && DEVICE_SECRET_PATTERN.test(value);

/** What the CRM sends and the bridge stores: lowercase sha256 hex, nothing else. */
export const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;

export const isSecretHash = (value: unknown): value is string =>
  typeof value === "string" && SECRET_HASH_PATTERN.test(value);

/**
 * KIOSK_REQUIRE_SECRET, the rollout switch. Off (unset) by default: a row
 * with no secret_hash bootstraps by reference alone, exactly as before 067.
 * On ("1" or "true"): such a row can no longer bootstrap. A row that HAS a
 * secret_hash is checked either way - the switch only decides what "no
 * secret set yet" means.
 */
export function kioskRequireSecret(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.KIOSK_REQUIRE_SECRET ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface SecretGuard {
  /** KIOSK_REQUIRE_SECRET (kioskRequireSecret()). */
  requireSecret: boolean;
  /** The caller presented a secret whose sha256 equals the row's secret_hash (deviceSecretMatches()). */
  secretMatches: boolean;
}

const NO_GUARD: SecretGuard = { requireSecret: false, secretMatches: false };

/**
 * What to do with a bootstrap for a known row (null = never seen).
 * Unbound is answered every time - it is what tells the tablet to keep
 * waiting - and costs nothing. Bound mints a session, so it is throttled.
 *
 * The secret is checked before the throttle and answers `unbound`, the
 * same word a reference nobody has assigned gets: a caller without the
 * secret learns nothing about whether the serial it tried is on a wall.
 *   row has a secret_hash   -> the secret must match, switch on or off
 *   row has none            -> as before, unless the switch is on
 */
export function bootstrapDecision(row: KioskDeviceRow | null, now: number, guard: SecretGuard = NO_GUARD): BootstrapDecision {
  if (!row || !row.restaurant_id) return "unbound";
  // `!= null`, not truthiness: an empty string is a hash nothing matches, not "no hash".
  if (row.secret_hash != null) {
    if (!guard.secretMatches) return "unbound";
  } else if (guard.requireSecret) {
    return "unbound";
  }
  if (row.last_bootstrap_at) {
    const t = new Date(row.last_bootstrap_at).getTime();
    if (!Number.isNaN(t) && now - t < BOOTSTRAP_MINT_MIN_INTERVAL_MS) return "throttled";
  }
  return "bound";
}

export const mayBootstrap = (recentCount: number): boolean =>
  Number.isInteger(recentCount) && recentCount < BOOTSTRAP_RATE_MAX;

/**
 * The one body every answer that mints nothing carries. `throttled` used
 * to say so; it now reads exactly like `unbound`, because "bound, but you
 * asked too soon" told anybody holding a serial that the serial is live.
 * The page never told them apart: both mean "ask again next tick".
 */
export const bootstrapWaitReply = (): { status: "unbound"; poll_every_ms: number } => ({
  status: "unbound",
  poll_every_ms: BOOTSTRAP_POLL_MS,
});

/**
 * May the tablet collecting a link code be issued a device secret for the
 * reference it says it is?
 *
 * Only an `aid:` reference (a Hexnode serial gets its secret from the CRM
 * through managed configuration, and two sources for one row would fight),
 * and only when the office has ALREADY bound that reference to the same
 * restaurant the code was linked to. The reference is the tablet's own
 * claim, so without that second condition a tablet linked to one restaurant
 * could name another restaurant's tablet and take over its bootstrap. With
 * it, the worst a liar gets is a secret for a restaurant it was just given
 * a session for anyway. An unbound row gets none: it cannot bootstrap, so
 * a secret planted on it would only be waiting for whoever is assigned next.
 */
export function mayIssueSecretOnLink(
  ref: unknown,
  row: Pick<KioskDeviceRow, "restaurant_id"> | null | undefined,
  linkedRestaurantId: string | null | undefined
): ref is string {
  if (!isDeviceRef(ref) || deviceRefKind(ref) !== "android_id") return false;
  if (!row?.restaurant_id || !linkedRestaurantId) return false;
  return row.restaurant_id === linkedRestaurantId;
}

/**
 * Which secrets a binding push from the CRM ends.
 *
 * `existing` = rows that currently hold a secret_hash; `incoming` = what
 * the CRM is about to write (restaurant_id already resolved to the local
 * uuid, null = unassign). Nothing changes while the restaurant stays the
 * same - the CRM re-sends the whole map after every MDM sync.
 *
 *   aid: reference, restaurant changes or is removed -> cleared. That secret
 *     was issued on the strength of a link to the OLD restaurant
 *     (mayIssueSecretOnLink), so it must not carry to the next one. The
 *     tablet gets a fresh one the next time it is linked there by code.
 *   Hexnode serial -> kept. Its secret was generated by the office and
 *     delivered by the MDM to that one unit; it says "this is that unit",
 *     which a move does not change, and clearing it would strand the tablet
 *     on the link-code screen at every reassignment until somebody pushed
 *     Hexnode again. Unassigned, it cannot mint whatever it holds
 *     (bootstrapDecision answers unbound before it looks at the secret).
 *     The office rotates or clears it through /api/crm/devices/:ref/secret.
 */
export function secretsEndedByBind(
  existing: readonly Pick<KioskDeviceRow, "device_ref" | "restaurant_id">[],
  incoming: readonly { device_ref: string; restaurant_id: string | null }[]
): string[] {
  const current = new Map(existing.map((r) => [r.device_ref, r.restaurant_id ?? null]));
  const out = new Set<string>();
  for (const b of incoming) {
    if (!current.has(b.device_ref)) continue;
    if (deviceRefKind(b.device_ref) !== "android_id") continue;
    if ((current.get(b.device_ref) ?? null) !== (b.restaurant_id ?? null)) out.add(b.device_ref);
  }
  return [...out];
}

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

/**
 * Has the office moved this tablet to another restaurant while it was
 * signed in? (Elijah, 2026-10-23: a Greek Style Gyro tablet reassigned to
 * Teriyaki Madness in the CRM kept showing Greek Style.)
 *
 * Bootstrap only runs when a tablet has no session, and a session refreshes
 * itself forever, so a reassignment never reached a tablet that was already
 * signed in - and the app has no sign-out button to force it. The heartbeat
 * now carries the device reference and asks this question every beat.
 *
 * True only when the reference is BOUND to a restaurant the session does not
 * cover. Unbound (back to stock, repair, never assigned) is false: signing a
 * working screen out because nobody has assigned it yet would trade a
 * paperwork gap for a restaurant missing orders.
 */
export function bindingMismatch(boundRestaurantId: string | null | undefined, sessionRestaurantIds: readonly string[]): boolean {
  if (!boundRestaurantId) return false;
  return !sessionRestaurantIds.includes(boundRestaurantId);
}
