# Go-live readiness test (GL) — the bridge side

Brief: [`docs/briefs/2026-11-01-go-live-readiness-test.md`](briefs/2026-11-01-go-live-readiness-test.md), package **GL1**
(this repo's PR merges before the CRM's). Code: `scripts/golive/`. Unit tests: `scripts/test-golive.ts` (in `npm test`).

## What it is

A synthetic market on the bridge **dev** database, plus a fake printer and a fake tablet for each restaurant, so GL2–GL4 can
send orders end to end without any hardware.

| Piece | Command | What it does |
|---|---|---|
| Seed | `npm run golive:seed -- [--restaurants 100] [--manifest f.json]` | Creates `[GL] Test Kitchen 001…100` through the CRM onboarding routes (`POST /api/crm/restaurants`, `/provision`, `/api/crm/devices`, `/api/crm/tablets/bind`): each gets a tablet login, a printer named `GL virtual Epson` and a bound tablet `GL-SIM-001…`. Find-or-create, so running it again changes nothing. |
| Simulate | `npm run golive:simulate -- [--minutes 10] [--out run.json] [--no-accept] [--tickets-dir d]` | **Virtual Epson:** polls `POST /api/print/epson` the way a TM-m30III does (GetRequest every 5 s; after each ticket a SetResponse `success="true"`) and records what would have printed. **Virtual tablet:** signs in with the restaurant's login (`/api/app/login`), polls `GET /api/dashboard/orders` at the real tablet cadence, sends a heartbeat every 2 min, and Accepts each new order. `--out` writes JSON (`printed[]`, `seen[]`, `accepted[]`, `errors[]`) for the CRM's GL runner to read. |
| Teardown | `npm run golive:teardown` | Deletes every `[GL]` restaurant and everything under it: orders, print jobs, devices, logins (auth users too), heartbeats, audit rows and `GL-SIM` kiosk rows. Runs in one transaction and follows every foreign key, including the SET NULL ones. |
| Selftest | `npm run golive:selftest` | The one command for this repo. It runs B1–B6 below and writes `docs/research/golive-runs/<timestamp>-bridge-selftest.md`. Exits 1 unless every check passes. |

Selftest checks: **B1** preflight · **B2** seed complete · **B3** seed idempotent (a second run changes no table's row count) · **B4**
each restaurant's test order is printed exactly once by its virtual Epson · **B5** each test order is seen and Accepted by its virtual tablet ·
**B6** teardown leaves zero rows (every table back to its starting count, auth tables included). It also reports print latency
(queued → printed) and tablet latency (received → seen), as p50/p95/p99/max.

## Matching the CRM's synthetic restaurants

Without a manifest, the CRM account id of restaurant *n* is `91000000-0000-4000-8000-` followed by *n* as 12 digits
(`…-000000000001`; `glCrmId(n)` in `scripts/golive/lib.ts`). The Zuppler id is `990000 + n`. The CRM's GL1 seed must do one of two things:

- create its accounts with those same ids, or
- write a manifest `[{ "crm_restaurant_id": "<accounts.id>", "name": "…", "zuppler_id": "…"? }]` and pass `--manifest` to the bridge seed.

Synthetic rows are marked by the restaurant name prefix `[GL] ` and the device ref prefix `GL-SIM-`. Teardown deletes by those markers only.

## Safety: nothing touches production

Every script runs these checks before it writes anything. Each failure stops the run with `REFUSED: …`:

1. `GL_BRIDGE_BASE_URL` is not `pfd-order-monitor.vercel.app` (add more with `GL_EXTRA_PROD_HOSTS`) and is https.
2. The database at `GL_BRIDGE_DATABASE_URL` has no real orders (any source except `test`, at non-`[GL]` restaurants) in the last 7 days,
   and no more than 20 non-`[GL]` restaurants.
3. The deployment's roster (`GET /api/crm/restaurants`) lists exactly the restaurants in that database, so the deployment is on the same
   database the checks just read. After the first restaurant is created, the seed checks it landed in that database before it creates the rest.

The scripts never read the app's own env names (`SUPABASE_SERVICE_ROLE_KEY`, `MIGRATION_DATABASE_URL`, `CRM_WRITE_KEY`). They read only
their own `GL_*` names, from `.env.golive`, which is git-ignored (`.env*`):

| Name | Value |
|---|---|
| `GL_BRIDGE_BASE_URL` | the `gl/**` preview URL (only `main` and `gl/**` branches build on Vercel, see `vercel.json`) |
| `GL_BRIDGE_DATABASE_URL` | the bridge **dev** project's session-mode connection string (port 5432) |
| `GL_CRM_WRITE_KEY` | that preview's `CRM_WRITE_KEY` (a dev-only value, never production's) |
| `GL_VERCEL_BYPASS` | optional: the Vercel "Protection Bypass for Automation" secret, if previews sit behind Vercel auth |

## STOP — Nick (2026-11-02): there is no bridge dev database yet

The bridge has only its production Supabase project. Brief rule 1 says load and scenario tests run on dev databases only, so nothing above has
run yet. One-time setup:

1. **Supabase → New project** in the org that owns the bridge, e.g. `pfd-bridge-dev`, same region as the bridge.
2. **Authentication → Rate Limits** on the dev project: raise the sign-in limit (100 virtual tablets sign in within a minute; the simulator retries, but a low limit stretches the run).
3. **SQL Editor:** run `db/schema.sql`. Then, from a laptop with this repo, apply the migrations:
   `MIGRATION_DATABASE_URL=<dev session-mode URL> npm run migrate`. Off Vercel the script runs; it reads only that variable.
4. **Vercel → pfd-order-monitor → Settings → Environment Variables:** give the **Preview** environment, scoped to branch `gl/**` if the UI
   offers it, the dev project's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, plus a new
   dev-only `CRM_WRITE_KEY`. **Check that Preview does not currently point at production.** If it does, any `gl/**` preview writes to the live
   database. The preflight's roster check would refuse to run in that case, but fix the setting either way.
5. Push any `gl/…` branch, then open `<preview>/api/health`. It should say `"schema": true`.
6. Fill in `.env.golive` and run `npm run golive:selftest`. Commit the report it writes.
