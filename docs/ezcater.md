# ezCater — Phase 2 (order-event subscriber)

Spec: prs-crm `docs/ezcater-ingestion-spec.md` §3. Scaffold: #90 (`lib/ezcater.ts`). Built 2026-09-28 on Matt's instruction.

## What it is

- **Webhook** `POST /api/ingest/ezcater`. ezCater POSTs a signed notification that carries no order data (`payload: null`), only ids. The route then does the following:
  1. It verifies `X-Ezcater-Signature`: the timestamp, a period, then the hex HMAC-SHA256 of `timestamp.body`, keyed with the subscriber's webhook secret.
  2. It fetches the order.
  3. It upserts the order into `ezcater_orders`, keyed on ezCater's order id.
  4. Every receipt is written to `webhook_receipts` with `source = 'ezcater'`, the refused ones included.
- **Events:** `accepted` and `cancelled`.
  - ezCater has **no "modified" event**. A modification is a second `accepted` for the same order id (https://api.ezcater.io/order-modifications). The order is re-fetched and the row updated, and `modified_at` is stamped when the items, money, time, headcount or address changed.
  - `uncancelled` is not subscribed yet.
- **Printing is OFF** (Matt, 2026-09-28). Ingested orders go to `ezcater_orders`, **not** `orders`. That means no print job, no tablet alert or chime, no unaccepted-order ticket, and no CRM accounting feed.
  - The next package promotes proven orders into `orders`. It adds an "ezCATER CATERING — due <date/time>" header, lead-time-aware routing, a per-location print toggle, and `'ezcater'` in `orders.source`.
  - Pricing in the CRM (the `ezcater` stream resolving to the account's **delivery** deal, with tips going to the driver) follows promotion.
- **Locations:** `ezcater_locations` has one row per caterer location from ezCater's `Caterers` query. Each is linked by hand to a bridge restaurant.
  - Only an **active** location is subscribed and ingested.
  - Activating one subscribes it at ezCater. Deactivating one deletes its subscriptions.
  - A location can't be active without a restaurant; a database CHECK enforces this.
- **Subscriber:** ezCater allows **one** per API user, and shows its webhook secret **once**, at creation. `/admin/ezcater` creates it and stores the secret in `ezcater_subscriber`, where only the service role can read it. `EZCATER_WEBHOOK_SECRET` overrides the stored secret if it's set.
- **Token:** `EZCATER_API_TOKEN` is set in Vercel production only, and is sent raw in `Authorization`. That's why every ezCater call runs from `/admin/ezcater` in the deployment.

## Bring-up (production, an admin on `/admin/ezcater`)

1. **Sync caterers.** This runs the Caterers query and upserts every location. The result table confirms the six seed prefixes, one line each:

   | Prefix | Restaurant |
   |---|---|
   | 7f2a4942 | Willie Mae's |
   | 0996f96f | Larry's |
   | 7a0e1f7d | Sylfoni's |
   | f72aee20 | El Molcajete |
   | e818e720 | All Seasons Sports Grill |
   | 43a61b77 | Torino's |

2. **Apply seed links.** This links each location to its restaurant, but only where exactly one caterer matches the prefix and exactly one restaurant matches the name. Anything else is reported, never guessed, and an existing link is never overwritten. **Nothing is switched on.** A restaurant with no bridge row, for example All Seasons if it has none, shows as `restaurant_missing`.
3. **Create subscriber.** Do this from the production site, because the webhook URL is the site's own `/api/ingest/ezcater`.
4. Switch **Willie Mae's** on. This subscribes `accepted` and `cancelled` for that location only. The other five stay linked and off until Matt says otherwise.
5. Accept a real Willie Mae's order in ezCater. Under "Recent notifications" it should show `created`, and under "Orders stored" it should show the order with its due time and total.
   - A later modification shows `updated` and "modified".
   - A cancel shows `cancelled`.
   - **Dry run one order** fetches and maps any order id without storing anything.
