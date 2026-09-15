/**
 * Simulate five hundred tablets against a deployment, for ten minutes.
 *
 * NOT in `npm test`. Run by hand against DEV (never production - it writes
 * five hundred heartbeats a cycle):
 *
 *   LOAD_BASE_URL=https://<dev deployment> \
 *   LOAD_COOKIE='sb-...-auth-token=...' \
 *   npx tsx scripts/load-500.ts [tablets=500] [minutes=10]
 *
 * What it does, per simulated tablet, on the real cadences with the real
 * jitter (lib/kiosk.ts):
 *   - a heartbeat POST every ~2 min (the same body the dashboard sends)
 *   - an orders poll every ~60 s (GET /api/version stands in for the
 *     PostgREST read, which needs a per-restaurant session; the request
 *     rate and function cold-start behaviour are what this measures)
 *
 * It reports p50 / p95 / max latency and the error rate per endpoint, and
 * the steady request rate it produced. The numbers go in docs/scale-500.md.
 *
 * LOAD_COOKIE is one signed-in tablet session's cookie header, so the
 * heartbeat authenticates; every simulated tablet beats as that restaurant,
 * which exercises the route, the rate limit (429 after the first beat in
 * any minute - counted separately, it is the limiter working) and the
 * upsert, without needing five hundred accounts.
 */
import { pollDelayMs, HEARTBEAT_EVERY_MS, withJitter } from "../lib/kiosk";

const BASE = process.env.LOAD_BASE_URL;
const COOKIE = process.env.LOAD_COOKIE ?? "";
const TABLETS = Number(process.argv[2] ?? 500);
const MINUTES = Number(process.argv[3] ?? 10);

if (!BASE) {
  console.error("LOAD_BASE_URL is required (a DEV deployment, never production)");
  process.exit(1);
}
if (/pfd-order-monitor\.vercel\.app\/?$/.test(BASE)) {
  console.error("Refusing to load-test the production hostname.");
  process.exit(1);
}

interface Sample {
  endpoint: string;
  ms: number;
  status: number;
  ok: boolean;
}
const samples: Sample[] = [];

async function hit(endpoint: string, init: RequestInit): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${endpoint}`, { ...init, headers: { ...(init.headers ?? {}), cookie: COOKIE } });
    await res.text();
    samples.push({ endpoint, ms: Date.now() - t0, status: res.status, ok: res.ok || res.status === 429 });
  } catch {
    samples.push({ endpoint, ms: Date.now() - t0, status: 0, ok: false });
  }
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function tablet(id: number, stopAt: number): Promise<void> {
  // Stagger the start across the first poll interval, as real tablets are
  // never switched on in the same second.
  await new Promise((r) => setTimeout(r, Math.random() * 60_000));
  let nextBeat = Date.now() + withJitter(HEARTBEAT_EVERY_MS);
  let nextPoll = Date.now() + pollDelayMs("live");
  while (Date.now() < stopAt) {
    const now = Date.now();
    if (now >= nextBeat) {
      await hit("/api/dashboard/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushSubscribed: true, shellVersion: 4 }),
      });
      nextBeat = Date.now() + withJitter(HEARTBEAT_EVERY_MS);
    }
    if (now >= nextPoll) {
      await hit("/api/version", { method: "GET" });
      nextPoll = Date.now() + pollDelayMs("live");
    }
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
  }
  void id;
}

async function main() {
  const stopAt = Date.now() + MINUTES * 60_000;
  console.log(`load-500: ${TABLETS} tablets for ${MINUTES} min against ${BASE}`);
  const started = Date.now();
  await Promise.all(Array.from({ length: TABLETS }, (_, i) => tablet(i, stopAt)));
  const elapsedS = (Date.now() - started) / 1000;

  for (const endpoint of [...new Set(samples.map((s) => s.endpoint))]) {
    const rows = samples.filter((s) => s.endpoint === endpoint);
    const ms = rows.map((s) => s.ms);
    const errors = rows.filter((s) => !s.ok).length;
    const limited = rows.filter((s) => s.status === 429).length;
    console.log(
      `${endpoint}: n=${rows.length} (${(rows.length / elapsedS).toFixed(2)} req/s) ` +
        `p50=${pct(ms, 50)}ms p95=${pct(ms, 95)}ms max=${Math.max(...ms)}ms ` +
        `errors=${errors} (${((100 * errors) / rows.length).toFixed(2)}%)` +
        (limited ? ` rate-limited=${limited}` : "")
    );
  }
  const all = samples.map((s) => s.ms);
  const errors = samples.filter((s) => !s.ok).length;
  console.log(`overall: n=${samples.length} (${(samples.length / elapsedS).toFixed(2)} req/s) p95=${pct(all, 95)}ms errors=${errors}`);
  process.exit(errors > 0 || pct(all, 95) > 500 ? 1 : 0);
}

void main();
