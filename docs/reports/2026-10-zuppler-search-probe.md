# Zuppler order search probe (MO0) — 2026-10-04

Brief: `docs/briefs/2026-10-04-missed-order-sweep.md` §2 MO0. Script: `scripts/probe-zuppler-search.mjs` (raw run output: `2026-10-zuppler-search-probe.run.md`).

## STOP — no auth variant works

**Question for Jerry (Zuppler):**

> "What auth does orders-api5 /v6/search take for PFD, and can it be the same token as LoadOrder?"

Context to send with it: our LoadOrder calls to `https://orders-api5.zuppler.com/graphql` carry **no credential at all** (Content-Type only — `lib/zuppler-mapper.ts` `fetchZupplerOrder()`), and they work. The same request shape to `POST /v6/search` returns **401 `"Unauthorized"`**. So "the same as LoadOrder" means no token, and that is refused. We need: the header name (`Authorization: Bearer …`? `api-token`?), the token or how to get one, and whether it is scoped to PFD's restaurants.

**When the answer arrives:** set `ZUPPLER_SEARCH_TOKEN` in `.env.local` (and later in Vercel), run `node scripts/probe-zuppler-search.mjs`; it tries Bearer, raw `Authorization` and `api-token` with that token and writes the shape, paging, states and timezone evidence to the `.run.md`. Then fill U2–U5 below and unblock MO1.

MO1 and MO2 are **not started**: both need the search response shape (U2), the "should have received" states (U3) and the timezone (U4), and the brief says never guess them.

## Answers

| # | Question | Answer | Evidence |
|---|---|---|---|
| U1 | Auth for `/v6/search` | **Open — STOP.** As-is (no credential, = LoadOrder) → 401. The bridge holds no Zuppler API credential to try as Bearer: its only Zuppler secret, `ZUPPLER_WEBHOOK_SECRET`, is the token *Zuppler sends us* on the webhook, and is not sent to Zuppler's API. | Run 2026-10-04T16:28Z, ids 29908, 29924, last 24 h: HTTP 401, body `"Unauthorized"` |
| U2 | Response shape, page size, last-page signal | **Open** — nothing returned past the 401. | — |
| U3 | Which states mean "the restaurant should have received this" | **Open** for search. What we know from LoadOrder: `order.state` exists; the webhook fires at confirmation (create) and cancel, and the ingest treats any state matching `/cancel/` as a cancellation (`lib/zuppler-ingest.ts`). The search's own state values are unknown. | `lib/zuppler-mapper.ts` header, `lib/zuppler-ingest.ts` |
| U4 | Timezone of `order_at` ranges | **Open.** The probe sends UTC wall-clock with no offset (like the sample) so the first successful run shows whether results line up with UTC or restaurant-local time. | — |
| U5 | Max ids per `any_of`; rate limit / 429 | **Open.** Ask Jerry alongside U1. | — |
| U6 | How the bridge dedupes today | **Answered.** `orders` has a unique index on `(source, external_id)` (`db/migrations/002_multi_source_print.sql`); for Zuppler `external_id` = LoadOrder `order.uuid` (the Zuppler order uuid). `lib/canonical.ts` `ingestOrder()` looks the pair up first (→ `duplicate`/`updated`) and treats a `23505` race as `duplicate`. Both existing Zuppler paths — the webhook (`app/api/ingest/zuppler`) and the receipt-email poll (`app/api/gmail/poll`) — go through `lib/zuppler-ingest.ts` `ingestZupplerOrderByUuid(uuid)`. MO1's recovery should call that same function with the uuid from the search hit, so a late webhook or a second sweep is a no-op. | code read 2026-10-04 |

## Count vs bridge

Not taken. Zuppler returned nothing to count, and this machine has no bridge Supabase env (`pfd-order-monitor/.env.local` is absent), so the script's bridge count is skipped. Re-run with `.env.local` (or `--production` with `.env.production.local`) once U1 is answered.

## Worth knowing for MO1

- The receipt-email poll (`/api/gmail/poll`, every 2 min) is already a second, independent way the bridge learns a Zuppler uuid — for inboxes that get Zuppler's order emails. The sweep covers the channels where neither the webhook nor the email reaches us.
- Unmapped restaurants: `ingestZupplerOrderByUuid` returns `unmapped` for a Zuppler restaurant id no bridge restaurant owns (`restaurant_zuppler_ids`, then legacy `restaurants.zuppler_restaurant_id`). The sweep's restaurant set should be exactly those two sources.
