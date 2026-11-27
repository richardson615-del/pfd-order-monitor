/**
 * What a tablet remembers about itself between page loads.
 *
 * Three facts, all in localStorage, all survivable when it is missing:
 *
 *   premium.restaurant  {id, name} - so the header and the offline page can
 *                       name the restaurant before (or without) the network
 *   premium.setupDone   "1" once the Ready screen has been shown on this
 *                       device - the first run is a one-time thing per unit
 *   premium.device      a random id the tablet mints once, which is what a
 *                       link code is bound to (see lib/link-code.ts)
 *   premium.deviceRef   the reference the Android shell put on the start
 *                       URL (?device=), which is what binds this tablet to
 *                       its restaurant (see lib/device-binding.ts)
 *   premium.deviceSecret  the device secret (SH1): what proves to the bridge
 *                       that this is that tablet and not somebody who read
 *                       its serial. From the shell (#dsec= on the start URL,
 *                       Hexnode managed configuration) or issued when a link
 *                       code is collected. Sent only in the body of
 *                       POST /api/kiosk/bootstrap; never put in a URL the
 *                       server sees, never shown.
 *
 * Every read and write is wrapped: storage throws in a private window, on a
 * cleared profile and under some kiosk policies, and none of those may take
 * the order list down. A tablet that cannot remember its restaurant name
 * shows the orders without one; it does not show nothing.
 *
 * public/offline.html reads the same keys by hand (it cannot import this
 * file - the worker serves it when the app cannot load), so the key names
 * are the contract. Change them here and there together.
 */

export const RESTAURANT_KEY = "premium.restaurant";
export const SETUP_DONE_KEY = "premium.setupDone";
export const DEVICE_ID_KEY = "premium.device";
/** The shell's device reference (?device= on the start URL), remembered so a lost session still knows who this tablet is. */
export const DEVICE_REF_KEY = "premium.deviceRef";

export function readDeviceRefCache(): string | null {
  try {
    const v = storage()?.getItem(DEVICE_REF_KEY);
    return v && /^[A-Za-z0-9:._-]{4,128}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The device secret (SH1). Same shape rule as lib/device-binding.ts's DEVICE_SECRET_PATTERN. */
export const DEVICE_SECRET_KEY = "premium.deviceSecret";
/** The fragment key the Android shell uses: /dashboard?shell=6&device=<ref>#dsec=<secret>. */
export const DEVICE_SECRET_FRAGMENT = "dsec";
const SECRET_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** The secret this tablet holds, or null. A missing or mangled one is null: the tablet then asks without, and lands on the link code. */
export function readDeviceSecret(): string | null {
  try {
    const v = storage()?.getItem(DEVICE_SECRET_KEY);
    return v && SECRET_SHAPE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keep a secret. True only if it is really there afterwards - a tablet must not believe it holds one it could not store. */
export function writeDeviceSecret(secret: unknown): boolean {
  if (typeof secret !== "string" || !SECRET_SHAPE.test(secret)) return false;
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(DEVICE_SECRET_KEY, secret);
    return s.getItem(DEVICE_SECRET_KEY) === secret;
  } catch {
    return false;
  }
}

/**
 * Can this browser keep a secret between page loads? Asked BEFORE the
 * tablet tells the bridge it wants one: a secret issued to a tablet that
 * cannot store it would lock that tablet out of bootstrap until the next
 * link.
 */
export function canKeepDeviceSecret(): boolean {
  try {
    const s = storage();
    if (!s) return false;
    const probe = "premium.probe";
    s.setItem(probe, "1");
    const ok = s.getItem(probe) === "1";
    s.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

/** The secret in a URL's fragment (#dsec=…), or null. Pure. */
export function readSecretFragment(url: string): string | null {
  try {
    const hash = new URL(url).hash.replace(/^#/, "");
    const v = new URLSearchParams(hash).get(DEVICE_SECRET_FRAGMENT);
    return v && SECRET_SHAPE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Take the shell's secret off the start URL: remember it, then remove the
 * fragment from the address so it is not in this page's history entry and
 * cannot be copied into a link, a `next=` or a report. A fragment is never
 * sent to a server, which is why the shell uses one rather than a query
 * parameter like ?device= - that one is in every request log.
 */
export function rememberDeviceSecretFromUrl(url: string): void {
  try {
    const secret = readSecretFragment(url);
    if (!secret) return;
    writeDeviceSecret(secret);
    if (typeof window !== "undefined" && window.location.href === url) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  } catch {}
}

/**
 * Remember the shell's reference if this URL carries one. Harmless anywhere else: no param, nothing written.
 * The shell's device secret rides on the same start URL (in the fragment), so it is taken here too -
 * every page that learns the reference learns both.
 */
export function rememberDeviceRef(url: string): string | null {
  rememberDeviceSecretFromUrl(url);
  try {
    const v = new URL(url).searchParams.get("device");
    if (v && /^[A-Za-z0-9:._-]{4,128}$/.test(v)) {
      storage()?.setItem(DEVICE_REF_KEY, v);
      return v;
    }
  } catch {}
  return readDeviceRefCache();
}

export interface CachedRestaurant {
  id: string;
  name: string;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readRestaurantCache(): CachedRestaurant | null {
  try {
    const raw = storage()?.getItem(RESTAURANT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return typeof v?.id === "string" && typeof v?.name === "string" ? { id: v.id, name: v.name } : null;
  } catch {
    return null;
  }
}

export function writeRestaurantCache(r: CachedRestaurant): void {
  try {
    storage()?.setItem(RESTAURANT_KEY, JSON.stringify({ id: r.id, name: r.name }));
  } catch {}
}

export function isSetupDone(): boolean {
  try {
    return storage()?.getItem(SETUP_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSetupDone(): void {
  try {
    storage()?.setItem(SETUP_DONE_KEY, "1");
  } catch {}
}

/**
 * This tablet's id, minted on first use. 32 url-safe characters from the
 * browser's CSPRNG. Without storage there is no stable id, so a fresh one
 * is returned each call - a link code bound to it would then only work for
 * the page that requested it, which is still correct, just less convenient.
 */
export function deviceId(): string {
  const s = storage();
  try {
    const existing = s?.getItem(DEVICE_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  } catch {}
  const id = mintDeviceId();
  try {
    s?.setItem(DEVICE_ID_KEY, id);
  } catch {}
  return id;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export function mintDeviceId(random: (n: number) => Uint8Array = cryptoBytes): string {
  // 64 symbols, so one byte's low six bits pick one uniformly.
  return Array.from(random(32), (b) => ALPHABET[b & 63]).join("");
}

function cryptoBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
