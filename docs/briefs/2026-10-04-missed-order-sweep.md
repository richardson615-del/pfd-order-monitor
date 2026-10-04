# Claude Code instruction package — Workstream MO: Missed-order sweep (Zuppler)

Date: 2026-10-04 · Author: Claude (chat) for Nick · Repos: `pfd-order-monitor` (bridge) first, then `prs-crm`

> **Status 2026-10-04:** MO0 stopped — `/v6/search` answers 401 to the LoadOrder request shape (no credential) and the bridge has no Zuppler API token. Question for Jerry at the top of `docs/reports/2026-10-zuppler-search-probe.md`. MO1, MO2 (bridge QUEUE rows 15-16) and MO3 (prs-crm QUEUE row 146) wait on it. The code **MO** was unused in both repos.

Repo rules win over this brief. If anything here conflicts with `README.md`, `docs/crm-bridge-contract.md` (bridge) or `CLAUDE.md` (CRM), stop and say so. If the letter **MO** is already used in either repo's `docs/briefs/`, pick the next unused two-letter code and say which one you used.

## 0. Why

A Zuppler order reaches us only through the `create` webhook (3 attempts within 1 minute, per Jerry Dani, 2026-09-30). If the bridge endpoint is down, slow or misconfigured for that minute, or a channel never had the webhook added (the Ariella incident, Aug 2026), the order is invisible until the customer calls. Zuppler has now given us a way to list orders: `POST https://orders-api5.zuppler.com/v6/search`. This workstream polls it, compares against what the bridge ingested, recovers anything missing through the normal ingest path, and raises an alert so dispatch knows.

## 1. Ground truth

**FACT (Jerry Dani, Zuppler, email 2026-09-30):**
- Endpoint: `POST https://orders-api5.zuppler.com/v6/search`. Sample body:
  ```json
  {
    "operator": "AND",
    "conditions": [
      { "field": "restaurant_id", "op": "any_of", "value": [<RestaurantID>] },
      { "field": "order_at", "op": "in_ranges", "value": [["2026-08-01T00:00:00", "2026-08-20T23:59:59"]] }
    ],
    "sort": [{ "field": "order_at", "order": "desc" }],
    "page": 1
  }
  ```
- `create` webhook retry: 3 attempts in 1 minute.
- Zuppler is adding webhook configuration to the Order Workflow (early week of 2026-10-05). After that, every channel fires the webhook. Until then, channels without a webhook row stay silent.
- `payments-api.zuppler.com/v5/transactions` exists for transaction queries. Auth is "to discuss on a call". It is **not** in scope here.

**FACT (project docs, `claude/PROVIDERS-zuppler.md`, `claude/ARCHITECTURE.md`):**
- Webhook events are `create` and `cancel` only. The body comes from the `LoadOrder` GraphQL query. Root `carts`, tenant key `carts.restaurantId`, money in cents.
- Unknown `restaurantId` returns 200 and is recorded as UNMATCHED. It is never an error.
- The bridge raises issue keys (for example `order_unaccepted:*`) that the CRM turns into trouble tickets through the issues feed.
- CRM partner records carry the Zuppler restaurant id (`zuppler_locations.zuppler_id`, e.g. Bellas 29908, Larry's 29924).

**UNKNOWN — probe first (MO0), never guess:**
- U1. **Auth** for `/v6/search`. Try the credentials the bridge already uses for `LoadOrder` (find them by env var *name* in code; never print values). Try in this order: as-is, `Authorization: Bearer`, then no auth.
- U2. Response shape: field names for order uuid, restaurant id, state/status, `order_at`, due/scheduled time, service type, totals; page size; how the last page is signalled.
- U3. Which states mean "the restaurant should have received this" (confirmed/accepted) versus pending, cancelled or failed payment.
- U4. Timezone of `order_at` ranges (the sample has no offset).
- U5. Max ids per `any_of` and any rate limit or 429 behaviour.
- U6. How the bridge dedupes today (Zuppler order uuid?). The recovery path must hit the same dedupe.

## 2. Packages

### MO0 — Probe (bridge repo, no production writes)
1. Write `scripts/probe-zuppler-search.mjs`. It reads the existing env (names only), calls `/v6/search` for 2–3 known restaurant ids over the last 24 h, and writes `docs/reports/2026-10-zuppler-search-probe.md`. The report covers which auth worked, the response shape (one order with customer name, phone, email and address **redacted**), paging, states seen, timezone evidence, and a count compared with the bridge's ingested orders for the same window.
2. Answer U1–U6 in the report.
3. **STOP** if no auth variant works. Write the exact question for Jerry at the top of the report: "What auth does orders-api5 /v6/search take for PFD, and can it be the same token as LoadOrder?" Then move on to nothing else in MO.

**Acceptance:** the report exists and every UNKNOWN is answered or explicitly still open. The PR is docs + script only.

### MO1 — Sweep job (bridge)
1. Add a provider-module function `searchZupplerOrders({ restaurantIds, from, to })` behind the existing Zuppler provider interface (thin, typed from MO0's real shape). It handles paging and batches ids up to the U5 limit.
2. Add a cron route (same pattern and auth as the bridge's existing crons) running **every 5 minutes**. The window is now − 3 h to now − 3 min (the 3-minute lag gives the webhook's retries time to finish).
3. Restaurant set = every restaurant the bridge routes Zuppler orders for (its own restaurant ↔ Zuppler id mapping).
4. For each search hit in a "should have received" state (U3) whose uuid the bridge has **not** ingested:
   - Ingest it through the **same code path** the webhook uses (`LoadOrder` → normalise → destinations), tagged `ingest_source = 'sweep'` (add the column or field per the bridge's migration rules). It is idempotent on the Zuppler uuid, so a late webhook or a second sweep is a no-op.
   - **Stale guard:** if the order's due time is more than **30 min** in the past, do **not** print or push it to the tablet. Record it and alert only; a stale ticket confuses the kitchen.
   - Raise issue key `order_missed_webhook:<zuppler_uuid>` with restaurant, due time, service, total, and whether it was delivered or alert-only.
5. Hits whose `cancel` the bridge missed: if Zuppler state is cancelled and the bridge has the order as live, apply the existing cancel path and raise `order_missed_cancel:<uuid>`.
6. **Mode flag** `ZUPPLER_SWEEP_MODE` = `off` | `shadow` | `live`, **default `shadow`**. Shadow mode detects and records "would have recovered" rows plus the issue, but does not ingest, print or cancel. Live mode does everything above.
7. Persist each run (start, end, restaurants, hits, missing, recovered, errors) in a small `sweep_runs` table. On search failure, log and raise **one** `zuppler_search_failing` issue after 3 consecutive failed runs. Never one issue per run.
8. Add a section to `docs/crm-bridge-contract.md` for the two new issue kinds and `ingest_source`.

**Tests:** a fixture-driven diff (ingested vs search) covering already ingested, missing and fresh, missing and stale, cancelled-but-live, unknown restaurant (ignored), and pending states (ignored). Idempotency: the sweep twice, and the sweep then a late webhook, each give one order and one print. Shadow mode performs no writes beyond `sweep_runs` and issues. Paging.

**Acceptance (Nick):** after 48 h in shadow, the run log shows zero errors and the "would recover" list is real misses, not false positives (each spot-checked against Chef). Then Nick sets `ZUPPLER_SWEEP_MODE=live`.

### MO2 — Channel-silence alarm (bridge)
For each restaurant with ≥ 20 Zuppler orders in the last 28 days, compare the search count with the webhook-ingested count per day. If the search shows orders but the webhook delivered **zero** for that restaurant over a rolling 2 h, raise `zuppler_channel_silent:<restaurant>` once per day. That is the Ariella case, caught the same day. Reuse MO1's data; no new Zuppler calls.

**Tests:** fixtures for silent, partially missing (MO1 handles it, no silence alarm) and quiet-day (no orders anywhere, no alarm).

### MO3 — CRM surfaces (prs-crm, after MO1 is merged)
1. Map the new issue kinds into trouble tickets through the existing issues-feed path:
   - `order_missed_webhook`: high priority. The title names the restaurant and due time; the body says "recovered and sent" or "too late — call the restaurant".
   - `order_missed_cancel`: high priority.
   - `zuppler_channel_silent`: high priority. The body says "ask Zuppler to add the webhook / Order Workflow to this restaurant's channel".
   - `zuppler_search_failing`: medium priority.
   - Each auto-resolves under the existing N2 rules (stays resolved while the key is present; reopens on recurrence).
2. Orders dashboard: a "Recovered" chip on rows with `ingest_source = sweep`.
3. Daily brief, Yesterday: "N Zuppler orders recovered by the sweep (M too late)". Hide the line when N = 0.

**Tests:** issue-kind → ticket mapping, chip rendering, Daily brief line hidden at 0.

## 3. Delivery

- Bridge first: MO0 → MO1 → MO2, one PR each, squash auto-merge on green CI (`gh pr merge --auto --squash`). Then MO3 in prs-crm.
- Add rows to `docs/briefs/QUEUE.md` in **both** repos (MO0–MO2 bridge, MO3 CRM, MO3 blocked by MO1). Put the queue edit in the first PR, not pushed onto an open PR branch.
- Copy this brief into both repos' `docs/briefs/` (same filename).
- Never push main, never `vercel --prod`, never print `.env*` values, migrations sequential, no card data anywhere, no customer PII in reports or logs (redact name, phone, email, address).

## 4. Open questions for Nick (defaults in bold; proceed on the default)

1. Stale cut-off for auto-sending a recovered order to the kitchen: **30 min past due time**.
2. Rollout: **ship in shadow mode; Nick flips to live after 48 h**.
3. Sweep cadence and window: **every 5 min, last 3 h, 3-min lag**.
4. Silence alarm threshold: **restaurants with ≥ 20 orders in 28 days, 2 h of zero webhooks while search shows orders**.

## 5. STOPs

- MO0: no working auth for `/v6/search` → ask Jerry (the question is written in the probe report).
- MO1 acceptance: Nick flips `ZUPPLER_SWEEP_MODE=live` where the bridge's env lives.
