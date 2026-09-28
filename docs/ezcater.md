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

1. **Apply seed links.** This needs no ezCater call. It creates the row for each of the six locations below if the row isn't there yet. Then it links each one to its bridge restaurant:
   - The caterer uuid must match exactly.
   - The restaurant must be the only one whose name equals the seed name. If none does, it must be the only one whose name contains the seed's keyword.
   - Anything else is reported, never guessed. A restaurant with no bridge row shows as `restaurant_missing`.
   - An existing link is never overwritten.
   - **Nothing is switched on.**

   | ezCater caterer uuid | Restaurant |
   |---|---|
   | 7f2a4942-1cc8-48ad-94d7-3dd09b241fb1 | Willie Mae's Barbeque |
   | 0996f96f-fd68-44f6-9db1-da4d54cd876b | Larry's |
   | 7a0e1f7d-af97-43a4-9bda-d6f757407f9f | Sylfoni's Pizza |
   | f72aee20-8e5d-49ed-bb77-114209078e19 | El Molcajete |
   | e818e720-1594-4a4f-868d-ff012fc1e29a | All Seasons Sports Grill |
   | 43a61b77-a508-4adc-b8a7-be3b24563820 | Torino's Greek & Italian |

2. **Sync caterers.** This needs `EZCATER_API_TOKEN` **in this Vercel project**. It runs the Caterers query, fills in each location's ezCater name, store number and address, and confirms every seed uuid is returned.
3. **Create subscriber.** Do this from the production site, because the webhook URL is the site's own `/api/ingest/ezcater`.
4. Switch **Willie Mae's** on. This subscribes `accepted` and `cancelled` for that location only. The other five stay linked and off until Matt says otherwise.
5. Accept a real Willie Mae's order in ezCater. Under "Recent notifications" it should show `created`, and under "Orders stored" it should show the order with its due time and total.
   - A later modification shows `updated` and "modified".
   - A cancel shows `cancelled`.
   - **Dry run one order** fetches and maps any order id without storing anything.
