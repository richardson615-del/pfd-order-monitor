/**
 * Remote firmware updates for PFD's Eatabit printers (firmware 2.9.0+).
 *
 * A printer asks POST /api/print/firmware every 15 minutes, sending its
 * device id (pfd-eatabit-<wifi mac>, the same id it pairs with) and its
 * version. The answer comes from the release plan in
 * eatabit-firmware-plan.json, which is edited by PR:
 *
 *   stable  - what every printer should run
 *   test    - a newer build for the device ids listed, tried there first
 *
 * The .bin files are served from public/firmware/eatabit/. A printer only
 * ever moves forward: an offer older than or equal to what it runs is not an
 * offer. Targeting is by device id, never by device key (keys pull print
 * jobs and stay out of git; scripts/test-no-device-keys.ts).
 */
import plan from "./eatabit-firmware-plan.json";
import orderboxPlan from "./orderbox-firmware-plan.json";

export type FirmwareRelease = { version: string; file: string; size: number; md5: string };
export type FirmwarePlan = {
  stable: FirmwareRelease | null;
  test: (FirmwareRelease & { devices: string[] }) | null;
};

export const RELEASE_PLAN = plan as FirmwarePlan;
export const FIRMWARE_PATH = "/firmware/eatabit/";

/**
 * One release plan per kind of box. The Eatabit reflash (ESP32) and the PFD
 * order box (Waveshare ESP32-S3 touchscreen) run different builds; offering
 * one the other's .bin would at best fail its check and at worst brick it.
 */
export type Product = "eatabit" | "orderbox";
export const RELEASE_PLANS: Record<Product, FirmwarePlan> = {
  eatabit: RELEASE_PLAN,
  orderbox: orderboxPlan as FirmwarePlan,
};

/**
 * Which product is asking. Order boxes send Product=orderbox and a
 * pfd-orderbox-<mac> device id; Eatabit firmware before the order box existed
 * sends no Product at all, so that means eatabit. Anything else is unknown.
 */
export function productOf(productParam: string | null, device: string): Product | null {
  const p = (productParam ?? "").trim().toLowerCase();
  if (p === "orderbox" || p === "eatabit") return p;
  if (p) return null;
  return device.toLowerCase().startsWith("pfd-orderbox-") ? "orderbox" : "eatabit";
}

export function firmwarePath(product: Product): string {
  return `/firmware/${product}/`;
}

/** "2.10.0" > "2.9.3". Unparseable means 0, so it never blocks an update. */
export function versionRank(v: string | null | undefined): number {
  const m = (v ?? "").trim().match(/^(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?/);
  if (!m) return 0;
  return Number(m[1]) * 1e8 + Number(m[2] ?? 0) * 1e4 + Number(m[3] ?? 0);
}

/** The release this printer should move to, or null when it is up to date. */
export function pickFirmware(planIn: FirmwarePlan, device: string, current: string): FirmwareRelease | null {
  const have = versionRank(current);
  const t = planIn.test;
  if (t && t.devices.map((d) => d.toLowerCase()).includes(device.toLowerCase()) && versionRank(t.version) > have) {
    const { devices: _devices, ...release } = t;
    return release;
  }
  const s = planIn.stable;
  if (s && versionRank(s.version) > have) return s;
  return null;
}

/** Plain-text reply the ESP32 parses line by line. */
export function firmwareReply(release: FirmwareRelease | null, origin: string, product: Product = "eatabit"): string {
  if (!release) return "update=none";
  const url = new URL(firmwarePath(product) + encodeURIComponent(release.file), origin).toString();
  return `update=${release.version}\nurl=${url}\nsize=${release.size}\nmd5=${release.md5}`;
}

/** Firmware version from the printer's own User-Agent ("pfd-eatabit/2.9.0" or "pfd-eatabit 2.8.5"). */
export function eatabitVersion(userAgent: string | null): string | null {
  return (userAgent ?? "").match(/^pfd-eatabit[\/ ]([0-9][0-9A-Za-z.\-]{0,20})/)?.[1] ?? null;
}
