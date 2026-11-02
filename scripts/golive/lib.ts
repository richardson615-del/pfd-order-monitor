/**
 * GL1 (go-live readiness test), bridge side: the pure parts of the harness.
 *
 * Brief: docs/briefs/2026-11-01-go-live-readiness-test.md (GL1).
 *
 * Everything here is free of network and database so scripts/test-golive.ts
 * can pin it in `npm test`. The scripts beside this file (seed, simulate,
 * teardown, selftest) do the I/O.
 *
 * How a synthetic row is recognised, everywhere:
 *   - restaurants: name starts with GL_NAME_PREFIX ("[GL] ")
 *   - simulated tablets: device_ref starts with GL_DEVICE_REF_PREFIX
 *   - CRM account ids (default, without a manifest): GL_CRM_ID_PREFIX + 12
 *     digits, so the CRM's GL1 seed can create the matching accounts with
 *     the same ids (glCrmId(n)).
 */

import { USERNAME_DOMAIN } from "../../lib/usernames";

export const GL_NAME_PREFIX = "[GL] ";
/** A tablet login's auth email is "<username>@tablet.pfdworks.com" (lib/usernames.ts). */
export const USERNAME_DOMAIN_SUFFIX = "@" + USERNAME_DOMAIN;
export const GL_DEVICE_REF_PREFIX = "GL-SIM-";
export const GL_CRM_ID_PREFIX = "91000000-0000-4000-8000-";
export const GL_ZUPPLER_ID_BASE = 990000;
export const GL_DEVICE_NAME = "GL virtual Epson";
export const GL_TIMEZONE = "America/Chicago";
export const GL_ACTOR = "golive-gl1";
export const DEFAULT_RESTAURANTS = 100;

/** Hostnames that are production. A GL run refuses them outright. */
export const PROD_HOSTS = ["pfd-order-monitor.vercel.app"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyntheticRestaurant {
  index: number;
  crm_restaurant_id: string;
  /** Always starts with GL_NAME_PREFIX. */
  name: string;
  zuppler_id: string;
  timezone: string;
  device_ref: string;
}

export interface ManifestEntry {
  crm_restaurant_id: string;
  name: string;
  zuppler_id?: string;
}

/** The CRM account id of synthetic restaurant n (1-based). Same formula in the CRM seed. */
export function glCrmId(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999_999) throw new Error(`bad restaurant index ${n}`);
  return GL_CRM_ID_PREFIX + String(n).padStart(12, "0");
}

export const pad3 = (n: number) => String(n).padStart(3, "0");

export function glName(name: string): string {
  return name.startsWith(GL_NAME_PREFIX) ? name : GL_NAME_PREFIX + name;
}

export const isGlName = (name: string | null | undefined) => typeof name === "string" && name.startsWith(GL_NAME_PREFIX);

/**
 * The synthetic market's restaurants. Without a manifest: count restaurants
 * named "[GL] Test Kitchen 001".. with glCrmId ids. With one (the CRM seed's
 * own list of accounts): exactly those ids and names, prefixed.
 */
export function syntheticRestaurants(count = DEFAULT_RESTAURANTS, manifest?: ManifestEntry[]): SyntheticRestaurant[] {
  if (manifest) {
    return manifest.map((m, i) => ({
      index: i + 1,
      crm_restaurant_id: m.crm_restaurant_id.toLowerCase(),
      name: glName(m.name),
      zuppler_id: m.zuppler_id ?? String(GL_ZUPPLER_ID_BASE + i + 1),
      timezone: GL_TIMEZONE,
      device_ref: GL_DEVICE_REF_PREFIX + pad3(i + 1),
    }));
  }
  if (!Number.isInteger(count) || count < 1 || count > 999) throw new Error(`restaurant count must be 1-999, got ${count}`);
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    crm_restaurant_id: glCrmId(i + 1),
    name: `${GL_NAME_PREFIX}Test Kitchen ${pad3(i + 1)}`,
    zuppler_id: String(GL_ZUPPLER_ID_BASE + i + 1),
    timezone: GL_TIMEZONE,
    device_ref: GL_DEVICE_REF_PREFIX + pad3(i + 1),
  }));
}

/** A manifest file's JSON, validated: [{ crm_restaurant_id, name, zuppler_id? }]. */
export function parseManifest(raw: unknown): ManifestEntry[] {
  const list = Array.isArray(raw) ? raw : (raw as any)?.restaurants;
  if (!Array.isArray(list) || !list.length) throw new Error("manifest: expected a non-empty array (or { restaurants: [...] })");
  if (list.length > 999) throw new Error("manifest: at most 999 restaurants");
  const seen = new Set<string>();
  const zups = new Set<string>();
  return list.map((e: any, i: number) => {
    const id = String(e?.crm_restaurant_id ?? "").trim().toLowerCase();
    if (!UUID.test(id)) throw new Error(`manifest[${i}]: crm_restaurant_id must be a uuid`);
    if (seen.has(id)) throw new Error(`manifest[${i}]: duplicate crm_restaurant_id ${id}`);
    seen.add(id);
    const name = String(e?.name ?? "").trim();
    if (!name) throw new Error(`manifest[${i}]: name required`);
    const out: ManifestEntry = { crm_restaurant_id: id, name };
    if (e?.zuppler_id != null && String(e.zuppler_id).trim() !== "") {
      const z = String(e.zuppler_id).trim();
      if (!/^\d+$/.test(z)) throw new Error(`manifest[${i}]: zuppler_id must be numeric`);
      if (zups.has(z)) throw new Error(`manifest[${i}]: duplicate zuppler_id ${z}`);
      zups.add(z);
      out.zuppler_id = z;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Guards: nothing in GL touches production.

/** null when the base URL may be used, else why not. */
export function checkBaseUrl(raw: string | undefined, extraProdHosts: string[] = []): string | null {
  if (!raw) return "GL_BRIDGE_BASE_URL is required (a gl/** preview deployment on the bridge DEV database)";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `GL_BRIDGE_BASE_URL is not a URL: ${raw}`;
  }
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (u.protocol !== "https:" && !local) return "GL_BRIDGE_BASE_URL must be https (or localhost)";
  if ([...PROD_HOSTS, ...extraProdHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)].includes(host)) {
    return `refusing the production hostname ${host}`;
  }
  return null;
}

export interface DbActivity {
  /** Restaurants not named "[GL] ...". */
  realRestaurants: number;
  /** Orders in the last 7 days at non-GL restaurants, source other than "test". */
  realOrders7d: number;
}

/** Max non-GL restaurants a dev database may hold. Production has hundreds. */
export const DEV_MAX_REAL_RESTAURANTS = 20;

/** null when the database looks like a dev database, else why it looks like production. */
export function checkDatabaseLooksDev(a: DbActivity): string | null {
  if (a.realOrders7d > 0) {
    return `this database has ${a.realOrders7d} real (non-test, non-GL) orders in the last 7 days - that is production or a shared database; GL runs only on an empty bridge dev project`;
  }
  if (a.realRestaurants > DEV_MAX_REAL_RESTAURANTS) {
    return `this database has ${a.realRestaurants} non-GL restaurants (dev limit ${DEV_MAX_REAL_RESTAURANTS}) - that looks like production`;
  }
  return null;
}

/**
 * The deployment and the database must be the same database: the roster the
 * deployment serves (GET /api/crm/restaurants, unfiltered) must list exactly
 * the restaurants in the database the scripts read. Otherwise the seed would
 * write through the deployment into some OTHER database - possibly
 * production - while the guards above inspected the dev one.
 */
export function checkSameDatabase(rosterIds: string[], dbIds: string[]): string | null {
  const roster = new Set(rosterIds.map((s) => s.toLowerCase()));
  const db = new Set(dbIds.map((s) => s.toLowerCase()));
  const onlyRoster = [...roster].filter((id) => !db.has(id));
  const onlyDb = [...db].filter((id) => !roster.has(id));
  if (!onlyRoster.length && !onlyDb.length) return null;
  return (
    `the deployment and GL_BRIDGE_DATABASE_URL are different databases ` +
    `(${onlyRoster.length} restaurants only in the deployment's roster, ${onlyDb.length} only in the database). ` +
    `Point the gl/** preview's Supabase env at the bridge dev project`
  );
}

// ---------------------------------------------------------------------------
// The virtual Epson printer: Server Direct Print, the printer's side.

/** What a TM-m30III answers after printing a job (PrintRequestInfo 1.00: no printjobid). */
export const EPSON_SUCCESS_RESPONSE =
  `<?xml version="1.0" encoding="utf-8"?><PrintResponseInfo Version="1.00"><ePOSPrint>` +
  `<Parameter><devid>local_printer</devid><printjobid></printjobid></Parameter>` +
  `<PrintResponse><response success="true" code="" status="251658262" battery="0"/></PrintResponse>` +
  `</ePOSPrint></PrintResponseInfo>`;

export const getRequestBody = (deviceKey: string) =>
  new URLSearchParams({ ConnectionType: "GetRequest", ID: deviceKey }).toString();

export const setResponseBody = (deviceKey: string, responseFile = EPSON_SUCCESS_RESPONSE) =>
  new URLSearchParams({ ConnectionType: "SetResponse", ID: deviceKey, ResponseFile: responseFile }).toString();

/** An empty 200 means "nothing to print". */
export const isEmptyEpsonReply = (body: string) => !/<PrintRequestInfo\b/i.test(body ?? "");

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** The text the printer would print, line by line (images are not text). */
export function eposTextLines(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) {
    for (const line of decodeXml(m[1]).split(/\r?\n|&#10;/)) {
      if (line.trim()) out.push(line.replace(/\s+$/, ""));
    }
  }
  return out;
}

/** The order number on a printed ticket ("ORDER #TEST-ABC123" -> "TEST-ABC123"), or null. */
export function eposOrderNumber(xml: string): string | null {
  for (const line of eposTextLines(xml)) {
    const m = line.match(/ORDER\s*#\s*([A-Za-z0-9-]+)/);
    if (m) return m[1];
  }
  return null;
}

/** How many tickets one reply carries (the route sends one; more is a protocol break for 1.00). */
export const eposJobCount = (xml: string) => (xml.match(/<ePOSPrint>/gi) ?? []).length;

// ---------------------------------------------------------------------------
// Numbers.

export interface Stats {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function stats(values: number[]): Stats {
  const v = values.filter((x) => Number.isFinite(x));
  return { n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: v.length ? Math.max(...v) : null };
}

export const fmtMs = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export type Counts = Record<string, number>;

/** Tables whose row count differs between two snapshots. */
export function diffCounts(before: Counts, after: Counts): { table: string; before: number; after: number }[] {
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return tables
    .map((t) => ({ table: t, before: before[t] ?? 0, after: after[t] ?? 0 }))
    .filter((d) => d.before !== d.after);
}

// ---------------------------------------------------------------------------
// The selftest report.

export type Verdict = "PASS" | "FAIL" | "BLOCKED";

export interface Check {
  id: string;
  name: string;
  verdict: Verdict;
  evidence: string;
}

export interface SelftestReport {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  commit: string | null;
  restaurants: number;
  checks: Check[];
  printLatency: Stats;
  tabletLatency: Stats;
  notes: string[];
}

export const overall = (checks: Check[]): Verdict =>
  checks.some((c) => c.verdict === "FAIL") ? "FAIL" : checks.some((c) => c.verdict === "BLOCKED") ? "BLOCKED" : "PASS";

export function renderSelftestReport(r: SelftestReport): string {
  const row = (s: Stats) => `${s.n} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.p99)} | ${fmtMs(s.max)}`;
  return [
    `# GL1 bridge selftest — ${overall(r.checks)}`,
    "",
    `Brief: docs/briefs/2026-11-01-go-live-readiness-test.md (GL1, bridge side)`,
    "",
    `- Started: ${r.startedAt}`,
    `- Finished: ${r.finishedAt}`,
    `- Deployment: ${r.baseUrl}`,
    `- Commit: ${r.commit ?? "Data missing"}`,
    `- Synthetic restaurants: ${r.restaurants}`,
    "",
    "| # | Check | Result | Evidence |",
    "|---|---|---|---|",
    ...r.checks.map((c) => `| ${c.id} | ${c.name} | **${c.verdict}** | ${c.evidence.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
    "## Latency (test order → virtual device)",
    "",
    "| Path | n | p50 | p95 | p99 | max |",
    "|---|---|---|---|---|---|",
    `| Queued → printed by the virtual Epson | ${row(r.printLatency)} |`,
    `| Received → seen by the virtual tablet | ${row(r.tabletLatency)} |`,
    "",
    "The tablet figure includes the real poll cadence (lib/kiosk.ts `pollDelayMs`), so it is",
    "bounded below by how often a real tablet asks, not only by the server.",
    "",
    ...(r.notes.length ? ["## Notes", "", ...r.notes.map((n) => `- ${n}`), ""] : []),
  ].join("\n");
}
