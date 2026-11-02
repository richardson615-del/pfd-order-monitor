/**
 * GL1 simulated devices: one virtual Epson printer and one virtual tablet per
 * synthetic restaurant, against the deployment under test.
 *
 *   npx tsx scripts/golive/simulate.ts [--minutes 10] [--out run.json] [--no-accept] [--tickets-dir dir]
 *
 * Virtual Epson = the printer's side of Server Direct Print, exactly as a
 * TM-m30III speaks it to POST /api/print/epson: GetRequest every 5 s (the
 * WebConfig interval, jittered), and after a ticket a SetResponse with
 * success="true". It records what would have printed: order number, the
 * ticket's text lines and its size (raw ePOS XML too, with --tickets-dir).
 *
 * Virtual tablet = the restaurant's tablet login (POST /api/app/login), then
 * the tablet's cadence: orders polled on lib/kiosk.ts pollDelayMs("live")
 * (GET /api/dashboard/orders, Bearer), a heartbeat every HEARTBEAT_EVERY_MS
 * with its GL-SIM device_ref, and Accept (PATCH /api/orders/:id
 * { accepted: true }) on each new order unless --no-accept.
 *
 * Output (--out): JSON { started_at, finished_at, base_url, printed[],
 * seen[], accepted[], errors[] } for the CRM's GL runner to read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { HEARTBEAT_EVERY_MS, pollDelayMs, withJitter } from "../../lib/kiosk";
import { baseUrl, call, sleep } from "./http";
import { connect, simTargets, type SimTarget } from "./db";
import { preflight } from "./preflight";
import { eposJobCount, eposOrderNumber, eposTextLines, getRequestBody, isEmptyEpsonReply, setResponseBody } from "./lib";
import { arg } from "./seed";

export const EPSON_INTERVAL_MS = 5_000;

export interface Printed {
  at: string;
  restaurant: string;
  order_number: string | null;
  bytes: number;
  lines: string[];
  poll_ms: number;
}
export interface Seen {
  at: string;
  restaurant: string;
  order_id: string;
  order_number: string;
  received_at: string;
  ms: number;
}
export interface Accepted {
  at: string;
  restaurant: string;
  order_id: string;
  status: number;
}
export interface SimError {
  at: string;
  restaurant: string;
  device: "printer" | "tablet";
  detail: string;
}

export interface SimOptions {
  accept?: boolean;
  ticketsDir?: string;
  epsonIntervalMs?: number;
  /** Tablet poll interval; default the real cadence (lib/kiosk.ts). */
  tabletPollMs?: () => number;
}

const form = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GL virtual Epson (TM-m30III Server Direct Print)" };

export class Simulator {
  printed: Printed[] = [];
  seen: Seen[] = [];
  accepted: Accepted[] = [];
  errors: SimError[] = [];
  private running = false;
  private loops: Promise<void>[] = [];
  readonly startedAt = new Date().toISOString();

  constructor(private targets: SimTarget[], private opts: SimOptions = {}) {}

  private err(restaurant: string, device: SimError["device"], detail: string) {
    this.errors.push({ at: new Date().toISOString(), restaurant, device, detail: detail.slice(0, 300) });
  }

  start(): void {
    this.running = true;
    if (this.opts.ticketsDir) mkdirSync(this.opts.ticketsDir, { recursive: true });
    for (const t of this.targets) {
      if (t.device_key) this.loops.push(this.printer(t));
      else this.err(t.name, "printer", "no active GL virtual Epson device - run the seed");
      if (t.username && t.password) this.loops.push(this.tablet(t));
      else this.err(t.name, "tablet", "no tablet login with a stored password - run the seed");
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }

  /** Sleep in short steps so stop() is prompt. */
  private async wait(ms: number) {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
  }

  private async printer(t: SimTarget): Promise<void> {
    const interval = this.opts.epsonIntervalMs ?? EPSON_INTERVAL_MS;
    // Printers are switched on at different moments.
    await this.wait(Math.random() * interval);
    while (this.running) {
      try {
        const r = await call("/api/print/epson", { method: "POST", headers: form, body: getRequestBody(t.device_key!) });
        if (r.status !== 200) this.err(t.name, "printer", `GetRequest ${r.status}`);
        else if (!isEmptyEpsonReply(r.text)) {
          const jobs = eposJobCount(r.text);
          if (jobs !== 1) this.err(t.name, "printer", `reply carried ${jobs} tickets (Server Direct Print 1.00 expects one)`);
          const orderNumber = eposOrderNumber(r.text);
          const at = new Date().toISOString();
          this.printed.push({ at, restaurant: t.name, order_number: orderNumber, bytes: r.text.length, lines: eposTextLines(r.text), poll_ms: r.ms });
          if (this.opts.ticketsDir) {
            writeFileSync(path.join(this.opts.ticketsDir, `${at.replace(/[:.]/g, "-")}-${(orderNumber ?? "doc").replace(/[^A-Za-z0-9-]/g, "")}.xml`), r.text);
          }
          const ack = await call("/api/print/epson", { method: "POST", headers: form, body: setResponseBody(t.device_key!) });
          if (ack.status !== 200) this.err(t.name, "printer", `SetResponse ${ack.status}`);
        }
      } catch (e) {
        this.err(t.name, "printer", e instanceof Error ? e.message : String(e));
      }
      await this.wait(withJitter(interval));
    }
  }

  private async tablet(t: SimTarget): Promise<void> {
    await this.wait(Math.random() * 5_000);
    let access = "";
    let refresh = "";
    const login = async () => {
      const r = await call("/api/app/login", { method: "POST", json: { username: t.username, password: t.password } });
      if (!r.ok) throw new Error(`login ${r.status} ${r.text.slice(0, 120)}`);
      access = r.body.access_token;
      refresh = r.body.refresh_token;
    };
    const authed = async (p: string, init: RequestInit & { json?: unknown } = {}) => {
      let r = await call(p, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${access}` } });
      if (r.status === 401) {
        const f = await call("/api/app/refresh", { method: "POST", json: { refresh_token: refresh } });
        if (f.ok) {
          access = f.body.access_token;
          refresh = f.body.refresh_token;
        } else await login();
        r = await call(p, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${access}` } });
      }
      return r;
    };
    // A hundred tablets signing in together can meet Supabase's sign-in rate
    // limit, and the route answers any refusal as 401 - so retry with
    // backoff before calling it a failure.
    for (let attempt = 1; ; attempt++) {
      try {
        await login();
        break;
      } catch (e) {
        if (attempt >= 5 || !this.running) {
          this.err(t.name, "tablet", `${e instanceof Error ? e.message : String(e)} (after ${attempt} attempts)`);
          return;
        }
        await this.wait(withJitter(15_000 * attempt));
      }
    }

    const known = new Set<string>();
    let nextBeat = 0;
    const pollMs = this.opts.tabletPollMs ?? (() => pollDelayMs("live"));
    while (this.running) {
      try {
        if (Date.now() >= nextBeat) {
          const hb = await authed("/api/dashboard/heartbeat", { method: "POST", json: { deviceRef: t.device_ref } });
          if (!hb.ok && hb.status !== 429) this.err(t.name, "tablet", `heartbeat ${hb.status}`);
          nextBeat = Date.now() + withJitter(HEARTBEAT_EVERY_MS);
        }
        const r = await authed("/api/dashboard/orders");
        if (!r.ok) this.err(t.name, "tablet", `orders ${r.status}`);
        else {
          for (const o of (r.body?.orders ?? []) as any[]) {
            if (known.has(o.id)) continue;
            known.add(o.id);
            // Orders from before the run are not arrivals - only orders that
            // came in while the simulator ran count for latency.
            if (Date.parse(o.received_at) < Date.parse(this.startedAt)) continue;
            const at = Date.now();
            this.seen.push({ at: new Date(at).toISOString(), restaurant: t.name, order_id: o.id, order_number: o.order_number, received_at: o.received_at, ms: at - Date.parse(o.received_at) });
            if (this.opts.accept !== false && !o.accepted_at && !o.cancelled_at) {
              const a = await authed(`/api/orders/${o.id}`, { method: "PATCH", json: { accepted: true } });
              this.accepted.push({ at: new Date().toISOString(), restaurant: t.name, order_id: o.id, status: a.status });
              if (!a.ok) this.err(t.name, "tablet", `accept ${o.order_number} ${a.status}`);
            }
          }
        }
      } catch (e) {
        this.err(t.name, "tablet", e instanceof Error ? e.message : String(e));
      }
      await this.wait(pollMs());
    }
  }

  result() {
    return {
      started_at: this.startedAt,
      finished_at: new Date().toISOString(),
      base_url: baseUrl(),
      devices: { printers: this.targets.filter((t) => t.device_key).length, tablets: this.targets.filter((t) => t.username && t.password).length },
      printed: this.printed,
      seen: this.seen,
      accepted: this.accepted,
      errors: this.errors,
    };
  }
}

async function main() {
  config({ path: ".env.golive" });
  const minutes = Number(arg("minutes") ?? 10);
  const out = arg("out");
  const db = await connect();
  let targets: SimTarget[];
  try {
    await preflight(db);
    targets = await simTargets(db);
  } finally {
    await db.end();
  }
  if (!targets.length) throw new Error("no [GL] restaurants - run scripts/golive/seed.ts first");
  const sim = new Simulator(targets, { accept: !process.argv.includes("--no-accept"), ticketsDir: arg("tickets-dir") });
  console.log(`simulate: ${targets.length} restaurants, ${minutes} min`);
  sim.start();
  await Promise.race([sleep(minutes * 60_000), new Promise((r) => process.once("SIGINT", r))]);
  await sim.stop();
  const res = sim.result();
  console.log(`simulate: printed ${res.printed.length}, tablet saw ${res.seen.length}, accepted ${res.accepted.length}, errors ${res.errors.length}`);
  if (out) writeFileSync(out, JSON.stringify(res, null, 2));
}

if (process.argv[1] && /simulate\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
