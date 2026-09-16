# Will the bridge hold 500 always-on tablets?

Written 2026-09-15 (E3). Every number below is either **measured** (with the
query or the page it came from) or **derived** from a measured one and
labelled so. Nothing here is a guess from memory; when a limit was not
visible on a dashboard it says so and where to look.

> **Revised 2026-09-16 (Nick's decisions on §6, PR `feat/poll-first`):**
> **Realtime is opt-in and off by default** (`NEXT_PUBLIC_REALTIME_ORDERS`);
> **the poll carries the orders, incrementally**; the load test is deferred
> to pre-launch. §0 below is the tradeoff; §1/§2 keep the original numbers
> with the poll-first numbers beside them.

## 0. Poll-first: the tradeoff (2026-09-16)

**Why.** Supabase Pro allows **500 concurrent Realtime connections**
(§4). One websocket per tablet meant the 500th tablet was the last one
that could connect, and the 501st would have failed silently — the exact
"quiet screen that looks fine" failure this whole system is built to
avoid. The alternatives were the Team plan (10,000 connections, at a
price not recorded here) or not holding a socket per tablet. Nick chose
the second.

**What a tablet does now** (`lib/order-sync.ts`, `components/OrderDashboard.tsx`):

| feed | before | now (Realtime off) |
|---|---|---|
| new order reaches the screen | Realtime INSERT (sub-second) | **Web Push → service worker → `postMessage` to the open page → sync** (seconds; the push was already the alarm) |
| backstop | poll every 60 s, **full** 200-row pull | poll every **30 s ±20 %**, **incremental**: `updated_at > <newest seen>` (migration 039) — usually **0 rows** |
| full pull | every poll | on load, on return to the foreground, after a poll failure, and **once an hour** regardless |
| "is this screen receiving orders?" | Realtime channel status | **the poll's own result**: live after a success, down after two failures in a row (`pollConnection`) |
| Realtime | always | `NEXT_PUBLIC_REALTIME_ORDERS=1` at build time turns it back on; the poll then drops to its old 60 s backstop and the socket's status drives the pill again |

**What it costs and saves at 500 tablets** (derived from §1/§2):

| resource | Realtime-always (before) | poll-first (now) |
|---|---|---|
| Realtime connections | 500 of 500 — **0 % headroom** | **0** |
| PostgREST reads | 8.3 req/s × ~20 KB | **16.7 req/s × ~0.3 KB** (an empty incremental answer) — twice the requests, ~1/70th the bytes |
| egress | ≈ 70 GB/month (§4) | **≈ 1 GB/month** from the poll; the hourly full pull adds 500 × 24 × 20 KB ≈ 0.25 GB |
| Vercel invocations | 12.5 req/s | **unchanged** — the poll goes to Supabase directly, not through a function |
| new-order latency | sub-second (socket) | push latency (typically 1–3 s); worst case one poll (≤ 36 s) if the push is lost |
| status change made elsewhere (opened on the other tablet, printed, cancelled) | sub-second | ≤ 36 s (next incremental poll) — acceptable; nothing chimes on those |

**What was given up.** Sub-second propagation of *changes* between two
screens at the same restaurant, and of a cancellation. The chime and
the notification never depended on the socket, so the alarm path is
unchanged. A tablet whose push subscription is broken now sees a new
order at the next poll (≤ 36 s) instead of at once — and that tablet is
already flagged "Alerts off" to the office by `push_subscribed`.

**What did not change.** Jitter on every timer (§5), the heartbeat
limiter, RLS on `orders` (the poll runs as the tablet's own user), the
push fan-out cap.

## 1. What a tablet does, per hour

From the client code (`lib/kiosk.ts`, `components/OrderDashboard.tsx`,
`components/AlertGate.tsx`), as of this PR:

| what | cadence | per tablet per hour |
|---|---|---|
| Supabase Realtime channel `orders-<restaurant>` | 1 persistent websocket — **only with `NEXT_PUBLIC_REALTIME_ORDERS` (2026-09-16)** | 1 connection, or **0** |
| orders poll (PostgREST) | every 60 s ±20 % with Realtime; **every 30 s ±20 %, incremental (`updated_at > cursor`), without (2026-09-16)** | 60 requests, or **120 tiny ones + 1 full pull** |
| heartbeat `POST /api/dashboard/heartbeat` (carries the version check) | every 120 s ±20 % | 30 requests |
| push re-record `POST /api/push/subscribe` | on visibility change only | ~0 |
| realtime messages received | one per order change at that restaurant | = that restaurant's order events |

The version check used to be a separate `/api/version` fetch on the same
cadence; C4 folded it into the heartbeat's response, so it is not a row here.

## 2. Projected load at 500 tablets (derived)

| resource | 500 tablets |
|---|---|
| Realtime concurrent connections | **500** (one each) with the flag on; **0** by default since 2026-09-16 |
| Vercel function requests, steady | 500 × (60 + 30) / 3600 = **12.5 req/s**, ~1.08 M/day |
| PostgREST reads (the poll) | 500 × 60 / 3600 = **8.3 req/s** with Realtime; **16.7 req/s** poll-first, almost all empty — this is the Supabase API + pooler, not a Vercel function |
| heartbeat upserts | 500 × 30 / 3600 = **4.2 writes/s** to `dashboard_heartbeats` |
| Realtime messages | orders-driven, see §3 — negligible against the 500/s limit |

## 3. Measured order volume (production, read-only, 2026-09-15)

Query run in the Supabase SQL editor on project `ucwqxznftqgjkumykbea`
(the order-monitor's production project — its ref is public in the site's
client bundle), last 30 days, `source <> 'test'`:

```sql
with m as (select date_trunc('minute', received_at) as minute, count(*) as n
           from orders where received_at >= now() - interval '30 days' and source <> 'test' group by 1),
     h as (select date_trunc('hour', received_at) as hour, count(*) as n
           from orders where received_at >= now() - interval '30 days' and source <> 'test' group by 1)
select (select count(*) from orders where received_at >= now() - interval '30 days' and source <> 'test') as orders_30d,
       (select count(distinct restaurant_id) from orders where received_at >= now() - interval '30 days' and source <> 'test') as restaurants_ordering,
       (select max(n) from m) as max_per_minute,
       (select percentile_cont(0.95) within group (order by n) from m) as p95_per_active_minute,
       (select count(*) from m) as active_minutes,
       (select max(n) from h) as max_per_hour,
       (select percentile_cont(0.95) within group (order by n) from h) as p95_per_hour,
       (select count(*) from restaurants where is_active) as active_restaurants,
       (select count(*) from restaurants where app_expected) as app_expected,
       (select count(*) from push_subscriptions) as push_subs,
       (select count(*) from dashboard_heartbeats where last_seen_at > now() - interval '5 minutes') as tablets_online_now;
```

| measured | value |
|---|---|
| orders, 30 days | **963** (≈ 32/day) |
| restaurants that placed any order | 40 of 46 active |
| busiest minute | **3 orders** |
| p95 of minutes that had any order | 2 |
| busiest hour | **25 orders** |
| p95 hour | 16.35 |
| `app_expected` restaurants | 1 (Willie Mae's) |
| push subscriptions | 1 |
| tablets online at query time (heartbeat < 5 min) | 0 |

**Scaled to 500 restaurants (derived, linear):** 963 / 40 restaurants ≈
24 orders per restaurant per month; × 500 ≈ **12,000 orders/month**, ≈
400/day. If the busiest hour scales linearly (25 orders across 40
restaurants), a 500-restaurant dinner peak is ≈ **310 orders/hour ≈ 5/min**.
Linear is the honest first estimate; restaurants added later will be
smaller on average, so this is if anything high.

Each order produces: one webhook (or one Gmail poll hit), one `orders`
insert, one realtime broadcast to that restaurant's one tablet (**1
message**), one push (**1 send** — the fan-out is per restaurant, and a
restaurant has one tablet), and zero-or-one print job. **5/min of any of
those is nothing.** Ingest is not the scale problem; the always-on
connections and timers are.

## 4. Plan limits vs projected

### Supabase (org on **Pro**, project compute **Micro** — org usage page, 2026-09-15)

| resource | plan limit | source | projected @500 | headroom |
|---|---|---|---|---|
| Realtime concurrent connections | **500** on Pro | docs.supabase.com/guides/realtime/limits (Team: 10,000) | 500 | **0 % — at the limit exactly.** See §6. |
| Realtime messages/s | 500 | same | < 1/s (orders-driven) | ~100 % |
| Realtime channel joins/s | 500 | same | 500 only if every tablet reconnects in one second — which is what `reconnectDelayMs` now prevents (spread over ≤ 60 s → ≤ ~10/s) | fine after this PR |
| Realtime peak connections this cycle | **2** measured | org usage page | — | — |
| Realtime messages this cycle | **101** measured | org usage page | — | — |
| DB direct connections (Micro) | 60 | docs.supabase.com/guides/platform/compute-and-disk | Vercel functions via pooler only | n/a |
| Pooler max clients (Micro) | **200** | same | 8.3 PostgREST reads/s + 4.2 heartbeat writes/s — each held for tens of ms → ~1–3 concurrent | ~98 % |
| Compute | Micro, 2-core shared, 1 GB | same; 569 Micro hours this cycle | 12.5 req/s of trivial queries | fine; watch memory |
| Egress this cycle | 3.562 GB | org usage page | poll = 500 × 60/h × ~20 KB (200 orders) ≈ 600 MB/h if every poll returned 200 rows; in practice a restaurant has ≤ ~30 recent orders, so ≈ **100 MB/h ≈ 70 GB/month** | Pro includes 250 GB (docs) — 70 % headroom, and the first thing to trim (§6) |

### Vercel (team **Pro**, Fluid compute **enabled**, region **iad1**, CPU **Standard 1 vCPU / 2 GB** — project Functions settings page, 2026-09-15)

| resource | plan limit | source | projected @500 | headroom |
|---|---|---|---|---|
| function max duration | default 300 s, max 800 s | vercel.com/docs/functions/configuring-functions/duration | crons set `maxDuration = 60` / `30`; the heartbeat is < 100 ms | fine |
| concurrency | auto-scales to 30,000 (Pro) | vercel.com/docs/functions/runtimes | 12.5 req/s × ~0.1 s ≈ 2 concurrent | ~100 % |
| cron jobs | not shown on the page read; the project runs 2 (`gmail/poll` every minute, `monitor/check` every 15) | — | unchanged by scale | check the Cron Jobs page before adding a third |
| function invocations | usage-billed on Pro | — | ~1.08 M/day ≈ 32 M/month from tablets alone | **this is the bill to watch** — see §6 |

## 5. What this PR changes so 500 do not all move at once

- **Poll** is a jittered timeout chain (±20 %), not a fixed interval: two
  tablets started in the same second drift apart within minutes.
- **Realtime reconnects** use exponential backoff with full jitter (1 s → 60 s
  cap) via `reconnectAfterMs`; after an outage the fleet returns over a
  minute instead of in one wave.
- **New-build reloads** are spread over 10 minutes from when each tablet
  hears of the build, on top of the existing quiet-moment gates.
- **Heartbeat** refuses a beat sooner than 60 s after the last one (429);
  the client reads 429 as "the server already has a fresh beat", which is
  true, so a runaway loop cannot make the pill lie or the database busy.
- **Push** fan-out is 20 in flight, 50 subscriptions per restaurant newest
  first, and already outside the ingest path (`attempt()` swallows it).
- **Gmail poll** and **health snapshot** log their wall time; the poll
  shouts past 45 s of its 60 s budget. The snapshot is whole-roster queries
  with in-memory joins (no per-restaurant round trips), which the log line
  will show staying flat.
- **RLS on `orders`** was checked, not assumed: `orders_select` is
  `is_admin() or belongs_to_restaurant(restaurant_id)` (`db/schema.sql`),
  and Realtime `postgres_changes` honours RLS for the authenticated role, so
  a tablet cannot subscribe to another restaurant's orders. No migration
  needed.

## 6. What to do before tablet #300

1. ~~Realtime connections~~ **Decided 2026-09-16: Realtime is opt-in, off
   by default; the poll carries the orders.** See §0. Turning it back on
   for the whole fleet is `NEXT_PUBLIC_REALTIME_ORDERS=1` on the
   deployment — and would need the Team plan past ~450 tablets.
2. ~~Egress~~ **Done 2026-09-16:** the poll is incremental
   (`orders.updated_at`, migration 039) with an hourly full pull.
3. **Function invocations:** ~32 M/month from tablets alone at 500
   (unchanged by poll-first — the poll goes to Supabase directly). Check
   the Pro plan's included invocations and per-million overage on the
   Vercel pricing page and put the number here.
4. **Load test — deferred to pre-launch (Nick, 2026-09-16).** Re-run
   `scripts/load-500.ts` against a dev deployment and replace the
   placeholder below with the numbers.

## 7. Load test

`scripts/load-500.ts` simulates N tablets for M minutes on the real
cadences with the real jitter, against a **dev** deployment (it refuses
the production hostname), and reports p50/p95/max and error rate per
endpoint. Not in `npm test`.

```
LOAD_BASE_URL=https://<dev deployment> LOAD_COOKIE='<one signed-in tablet session cookie>' \
  npx tsx scripts/load-500.ts 500 10
```

**Result:** _not yet run — there is no dev deployment of this repo with a
signed-in tablet session at the time of writing. Run it once the MDM trial
tablet exists on dev and paste the output here. Acceptance: p95 < 500 ms,
0 errors (429s from the heartbeat limiter are counted separately and are
the limiter working)._
