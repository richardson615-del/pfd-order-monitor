/**
 * MO0 — probe Zuppler's order search (docs/briefs/2026-10-04-missed-order-sweep.md).
 *
 *   POST https://orders-api5.zuppler.com/v6/search
 *
 * Read-only on both sides: one search per auth variant against Zuppler, and
 * (when the bridge's Supabase env is present) one count of orders already
 * ingested for the same restaurants and window. Nothing is written anywhere
 * except the report.
 *
 * Auth variants, in the brief's order (U1):
 *   1. as-is   - exactly what LoadOrder sends today (lib/zuppler-mapper.ts
 *                fetchZupplerOrder): Content-Type only, no credential.
 *   2. bearer  - Authorization: Bearer $ZUPPLER_SEARCH_TOKEN
 *   3. raw     - Authorization: $ZUPPLER_SEARCH_TOKEN  (no scheme)
 *   4. api-token header - api-token: $ZUPPLER_SEARCH_TOKEN (the header
 *                Zuppler's own webhook uses toward us)
 * 2-4 are skipped while ZUPPLER_SEARCH_TOKEN is unset. The bridge holds no
 * Zuppler API credential today; ZUPPLER_WEBHOOK_SECRET is OUR inbound token
 * and is deliberately never sent to Zuppler's API.
 *
 * Output: docs/reports/2026-10-zuppler-search-probe.run.md (raw run). The
 * hand-kept report docs/reports/2026-10-zuppler-search-probe.md carries the
 * U1-U6 answers, including the ones that come from reading our own code.
 *
 * PII: every value under a key that looks like name/phone/email/address/
 * street/zip/city is replaced with "<redacted>" before anything is written.
 * Env values are never printed - names only.
 *
 * Usage:
 *   node scripts/probe-zuppler-search.mjs [--production] [--ids 29908,29924] [--hours 24]
 */
import { config } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";

const argv = process.argv.slice(2);
const isProduction = argv.includes("--production");
config({ path: isProduction ? ".env.production.local" : ".env.local" });
config();

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export const SEARCH_URL = "https://orders-api5.zuppler.com/v6/search";
const REPORT = "docs/reports/2026-10-zuppler-search-probe.md";
const MAX_PAGES = 20;
// Bellas 29908, Larry's 29924 (brief §1, CRM zuppler_locations.zuppler_id).
const ids = arg("ids", "29908,29924").split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
const hours = Number(arg("hours", "24"));

// U4 is unknown: the sample range has no offset. Send UTC wall-clock without
// a suffix, exactly like the sample, and record what comes back.
function noOffset(d) {
  return d.toISOString().slice(0, 19);
}
const to = new Date();
const from = new Date(to.getTime() - hours * 3600_000);

export function searchBody(restaurantIds, fromStr, toStr, page) {
  return {
    operator: "AND",
    conditions: [
      { field: "restaurant_id", op: "any_of", value: restaurantIds },
      { field: "order_at", op: "in_ranges", value: [[fromStr, toStr]] },
    ],
    sort: [{ field: "order_at", order: "desc" }],
    page,
  };
}

const PII_KEY = /name|phone|email|address|street|zip|city|cross|instructions|first|last|lat|lng|lon/i;
// Keys that look like PII by the regex but carry no customer data.
const PII_KEEP = /^(restaurant_?name|channel_?name|service_?name|state_?name|menu_?name|category)$/i;

export function redact(v, key = "") {
  if (key && PII_KEY.test(key) && !PII_KEEP.test(key) && v !== null && typeof v !== "object") return "<redacted>";
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => redact(x, key));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = redact(x, k);
    return out;
  }
  return v;
}

/** "path: type" lines for every leaf, arrays collapsed to [] - the shape without the data. */
export function shapeOf(v, path = "", out = new Map()) {
  if (Array.isArray(v)) {
    if (!v.length) out.set(`${path}[]`, "empty array");
    for (const x of v.slice(0, 5)) shapeOf(x, `${path}[]`, out);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) shapeOf(x, path ? `${path}.${k}` : k, out);
  } else {
    const t = v === null ? "null" : typeof v;
    const prev = out.get(path);
    out.set(path, prev && prev !== t ? `${prev}|${t}` : t);
  }
  return out;
}

function variants() {
  const token = process.env.ZUPPLER_SEARCH_TOKEN;
  const base = { "Content-Type": "application/json" };
  const list = [{ name: "as-is (no credential, same as LoadOrder)", headers: base }];
  if (token) {
    list.push({ name: "Authorization: Bearer $ZUPPLER_SEARCH_TOKEN", headers: { ...base, Authorization: `Bearer ${token}` } });
    list.push({ name: "Authorization: $ZUPPLER_SEARCH_TOKEN", headers: { ...base, Authorization: token } });
    list.push({ name: "api-token: $ZUPPLER_SEARCH_TOKEN", headers: { ...base, "api-token": token } });
  }
  return list;
}

async function post(headers, page) {
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(searchBody(ids, noOffset(from), noOffset(to), page)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: text.slice(0, 200) };
}

/** The order list inside a search response, wherever it sits. */
export function ordersOf(json) {
  if (Array.isArray(json)) return json;
  for (const k of ["orders", "data", "results", "items", "records", "hits"]) {
    if (Array.isArray(json?.[k])) return json[k];
    if (Array.isArray(json?.[k]?.orders)) return json[k].orders;
  }
  return null;
}

async function bridgeCount() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { note: "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set on this machine - count not taken." };
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const zids = ids.map(String);
  const { data: links } = await db.from("restaurant_zuppler_ids").select("restaurant_id, zuppler_restaurant_id").in("zuppler_restaurant_id", zids);
  const { data: legacy } = await db.from("restaurants").select("id, zuppler_restaurant_id").in("zuppler_restaurant_id", zids);
  const rids = [...new Set([...(links ?? []).map((l) => l.restaurant_id), ...(legacy ?? []).map((r) => r.id)])];
  if (!rids.length) return { note: `no bridge restaurant maps Zuppler ids ${zids.join(", ")}` };
  const { count, error } = await db
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("source", "zuppler")
    .in("restaurant_id", rids)
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString());
  if (error) return { note: `count failed: ${error.message}` };
  return { count, note: `${rids.length} bridge restaurant(s), orders.source = 'zuppler', created_at in window` };
}

async function main() {
  const tried = [];
  let winner = null;
  for (const v of variants()) {
    const r = await post(v.headers, 1);
    tried.push({ variant: v.name, status: r.status, body: r.json === null ? r.text : JSON.stringify(r.json).slice(0, 120) });
    if (r.status >= 200 && r.status < 300 && r.json !== null) { winner = { ...v, first: r }; break; }
  }

  const lines = [];
  lines.push("# Zuppler order search probe (MO0)", "");
  lines.push(`Generated by \`scripts/probe-zuppler-search.mjs\` at ${new Date().toISOString()} (${isProduction ? "production" : "local"} env).`);
  lines.push(`Zuppler restaurant ids: ${ids.join(", ")} · window: last ${hours} h, sent as \`${noOffset(from)}\` → \`${noOffset(to)}\` (UTC wall-clock, no offset).`, "");

  if (!winner) {
    lines.push("## STOP — no auth variant works", "");
    lines.push("**Question for Jerry (Zuppler):** \"What auth does orders-api5 /v6/search take for PFD, and can it be the same token as LoadOrder?\"", "");
    lines.push("LoadOrder (`https://orders-api5.zuppler.com/graphql`) is called with no credential at all, so \"the same as LoadOrder\" means none — and none is refused.", "");
  }

  lines.push("## U1 — Auth", "", "| Variant | HTTP | Body (first 120 chars) |", "|---|---|---|");
  for (const t of tried) lines.push(`| ${t.variant} | ${t.status} | \`${String(t.body).replace(/\|/g, "\\|")}\` |`);
  if (!process.env.ZUPPLER_SEARCH_TOKEN) lines.push("", "Variants 2-4 skipped: `ZUPPLER_SEARCH_TOKEN` is not set (the bridge holds no Zuppler API credential).");
  lines.push("");

  if (winner) {
    const pages = [winner.first];
    let p = 1;
    while (p < MAX_PAGES) {
      const list = ordersOf(pages[pages.length - 1].json);
      if (!list || !list.length) break;
      p += 1;
      const next = await post(winner.headers, p);
      pages.push(next);
      if (next.status !== 200) break;
    }
    const all = pages.flatMap((pg) => ordersOf(pg.json) ?? []);
    const top = winner.first.json;
    lines.push("## U2 — Response shape", "");
    lines.push(`Top-level keys: \`${Array.isArray(top) ? "(array)" : Object.keys(top ?? {}).join("`, `")}\``, "");
    lines.push("Leaf paths of the first orders:", "", "```");
    for (const [k, t] of shapeOf(all.slice(0, 5))) lines.push(`${k}: ${t}`);
    lines.push("```", "", "One order, PII redacted:", "", "```json", JSON.stringify(redact(all[0] ?? null), null, 2), "```", "");
    lines.push("## Paging", "");
    lines.push(`Pages fetched: ${pages.length} · orders per page: ${pages.map((pg) => (ordersOf(pg.json) ?? []).length).join(", ")} · statuses: ${pages.map((pg) => pg.status).join(", ")}`, "");
    const nonList = Array.isArray(top) ? {} : Object.fromEntries(Object.entries(top ?? {}).filter(([, v]) => !Array.isArray(v)));
    lines.push(`Non-list top-level fields (paging metadata?): \`${JSON.stringify(nonList)}\``, "");
    const stateKeys = ["state", "status", "order_state", "workflow_state"];
    const states = {};
    for (const o of all) for (const k of stateKeys) if (o?.[k] != null) states[`${k}=${o[k]}`] = (states[`${k}=${o[k]}`] ?? 0) + 1;
    lines.push("## U3 — States seen", "", "```", JSON.stringify(states, null, 2), "```", "");
    const times = all.slice(0, 5).map((o) => o?.order_at ?? o?.orderAt ?? o?.created_at ?? null);
    lines.push("## U4 — Timezone evidence", "", `First \`order_at\` values: \`${JSON.stringify(times)}\``, "");
    lines.push("## Count vs bridge", "", `Zuppler search: ${all.length} order(s).`);
  } else {
    lines.push("## U2-U5", "", "Open: nothing can be learned about the response, paging, states, timezone or limits until a request is accepted.", "");
    lines.push("## Count vs bridge", "");
  }
  const bc = await bridgeCount();
  lines.push(`Bridge: ${bc.count ?? "—"} (${bc.note}).`, "");

  mkdirSync("docs/reports", { recursive: true });
  writeFileSync(REPORT.replace(/\.md$/, ".run.md"), lines.join("\n") + "\n");
  console.log(`Wrote ${REPORT.replace(/\.md$/, ".run.md")}. Auth: ${winner ? winner.name : "none worked"}.`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
