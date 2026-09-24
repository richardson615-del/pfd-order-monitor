# Brief: relink a bridge restaurant to a different CRM account (unblocks CRM account merges)

Author: Nick (via Claude) · Date: 2026-09-24 · Repo: pfd-order-monitor
Cross-repo: this PR merges **before** prs-crm queue row 60 step 1 resumes. Repo rules win.

## 0. Why
The CRM has duplicate accounts for two live restaurants. Its merge refuses to run because the bridge restaurant is linked to the duplicate, so its printers, tablets and orders would be orphaned.
- **El Molcajete:** duplicate `29fafb74-b318-4de2-9fa9-2a8d379a8296` → survivor `fbd40571-51b1-4c6c-aa8c-8487cfa75d98`.
- **J & L Liquors:** duplicate `f03dd879-cee9-4e81-bf7e-99ba247aea70` → survivor `35fcaa49-20cf-4854-a108-47fca96b4a9e`.

prs-crm row 60 (PR #335) stopped with: "the bridge has no endpoint to relink a restaurant to another CRM account (checked pfd-order-monitor origin/main 2026-09-24)".

## 1. Ground truth (FACT, `docs/crm-bridge-contract.md`)
- Each bridge restaurant has its own uuid (`restaurants.id`) and the CRM account id in `restaurants.crm_restaurant_id`.
- Every `/api/crm/restaurants/:id/*` accepts either id, resolved by `lib/restaurant-ref.ts`.
- `POST /api/crm/restaurants` find-or-creates by `crm_restaurant_id`. Nothing changes `crm_restaurant_id` after creation.

## 2. Build
1. **`POST /api/crm/restaurants/:id/relink`**, with body `{ crm_restaurant_id: <new CRM account id>, actor }`. Auth is the same as the other CRM write routes (`CRM_WRITE_KEY`).
   - `:id` accepts either id, as today.
   - Set `restaurants.crm_restaurant_id` to the new value. **Nothing else changes**: the restaurant's own `id`, printers, tablets, logins, orders, Zuppler ids and settings all stay put.
   - **Idempotent:** already linked to that account → `200 { ok, changed: false }`.
   - **409 `crm_account_taken`** if another bridge restaurant already has that `crm_restaurant_id`. Name that restaurant in the message and never merge two bridge restaurants.
   - **400** if the value isn't a uuid; **404** if `:id` is unknown.
   - Returns `{ ok, changed, restaurant }` in the roster shape, with the old and new `crm_restaurant_id`.
   - Writes an audit/event row: actor, old and new account id, time.
2. Check anything cached by `crm_restaurant_id` (roster, `restaurant-ref` lookups, kiosk bootstrap, accounting joins) and invalidate or refresh it, so the next call by the new id resolves immediately.
   - After relinking, `GET /api/crm/accounting/orders?restaurant_id=<new id>` returns the restaurant's orders, **including ones from before the relink**. The link is the restaurant, not the order.
   - Say in the PR if any table stores `crm_restaurant_id` per order. If one does, stop and report rather than rewriting history.
3. Document the route in `docs/crm-bridge-contract.md` under Restaurants.
4. **Tests:**
   - relink changes only `crm_restaurant_id`;
   - a second call → `changed: false`;
   - an account already taken → 409 naming the other restaurant;
   - after relink, lookup by the new account id resolves and lookup by the old one gives 404;
   - accounting orders by the new id include pre-relink orders;
   - tablets and printers unchanged.

## 3. Acceptance (Nick)
1. Merge. Then on the CRM, prs-crm row 60 step 1 calls this route from the merge preview's "Move the bridge link to the survivor".
2. Merge El Molcajete 29fafb74 → fbd40571 and J and L f03dd879 → 35fcaa49.
3. Both tablets still get orders, and the CRM's tablet inventory shows them under the surviving accounts.
