# Claude Code instruction package — Workstream O: In-house manual (phone) order entry with saved customer cards

Author: Nick (via Claude) · Date: 2026-09-18 · Cross-repo: **yes** (pfd-order-monitor O1 first, then prs-crm O2–O7) · Clone: prs-crm (spare) for CRM packages; pfd-order-monitor for O1.

Repo rules (`CLAUDE.md` in each repo) win over this brief. If a rule blocks a step, stop and say so.

---

## 0. Nick's intent (verbatim gist)

> We want to place manual orders in-house. We currently use Data Dreamers for this. We'd use the Zuppler menus, and we want to save customers' credit card information because they call to place the order and we don't want to ask for the card every time.

> (2026-09-18, later) We want to use a different payment processor so we can save on fees.

> (2026-09-19) Live processor for phone orders = **Helcim** (decision); Nick is opening the account and will hand over sandbox keys this week. Global Payments only displaces it if the Genius rep's written interchange-plus quote comes in meaningfully under Helcim's published rate.

> (2026-09-18, later) We are getting rid of Data Dreamers. All we use it for now is manual orders and dispatching; dispatch moves to Shipday, so manual ordering is the only thing we need from Data Dreamers.

Outcome: a dispatcher answers the phone, looks the customer up by phone number, builds the order from that restaurant's Zuppler menu, charges the card on file (or cash / new card), and the order reaches the restaurant exactly like a Zuppler order does today (printer / tablet / email) and shows on the CRM Orders dashboard; if it is a delivery order it is created in **Shipday** for driver dispatch. When that works, Data Dreamers is switched off entirely (dispatch is already leaving for Shipday).

---

## 1. Ground truth

### FACT — what exists today (read from code)

**CRM (prs-crm)**
- Orders in the CRM are **read-only views of the bridge's `orders` table** via `src/lib/printer-bridge.ts` → `https://pfd-order-monitor.vercel.app/api/crm/*`, Bearer `CRM_WRITE_KEY` (`docs/crm-bridge-contract.md:3-4`). Page `src/app/(app)/orders/page.tsx`, components `OrdersDashboard.tsx`, `OrderDrawer.tsx`, pure rules in `src/lib/orders-shared.ts`. Access predicate `canViewOrders()` in `src/lib/orders-access.ts` = admin | dispatcher | tech | accounting.
- Order shape (bridge): `source` (`zuppler | email | test`), `external_id`, `restaurant_id`, `order_number`, `received_at`, `order_type`, `due_time`, `customer_name/phone/address`, `items` jsonb `{name, price, modifiers[]}[]`, money fields, `payment_type` (display string), `notes`, `status`, timestamps (`orders-dashboard.md:13`, `contract:533-744`).
- **No end-consumer customer entity** anywhere in the CRM schema (`migrations/0001` has users/accounts/research/activities only). Customer data exists only as denormalised strings on bridge orders.
- **No payment gateway, tokenization, or card handling** in either repo. `CardPaymentForm.tsx` + migration `0072` are the *driver Focus paycard* ledger — unrelated. `payment-shared.ts` is restaurant payout scheduling — unrelated. `package.json` has no payment SDK.
- **No Zuppler API client in the CRM.** Zuppler data = `zuppler_locations` table imported from CSV (`0052`), `admin_url` deep links (`AccountZupplerBlock.tsx`). Zuppler ordering sites are Zuppler-hosted; changes go through Kate at Zuppler (`dev/CLAUDE.md:14`).
- "Order intake" (`OrderIntakePanel.tsx`, `0050`, `0074`) means **how a restaurant receives orders** (printer / tablet / email), not entering orders. Do not reuse the name.
- Route-handler convention: `requireSession` → role check → zod → `src/lib/<domain>.ts` → `handleApiError`; domain errors as `class FooError extends Error` mapped in `src/lib/api-errors.ts`; no shadcn Dialog (hand-rolled `fixed inset-0`); external services = thin client module in `src/lib/` with a provider interface, mocked at that boundary (`prs-crm/CLAUDE.md:733-749`).
- Client components import only from pure `*-shared.ts` modules (`order-destinations.ts:1-9`).
- Roles: `caller | closer | onboarding | admin | dispatcher` + area roles `accounting | dev | tech`. **Do not add a role** (six edits + parity test); reuse dispatcher/admin like M2 did.
- Page and API must share one access predicate in `src/lib/` (`prs-crm/CLAUDE.md:242-246`).
- `prs-crm/CLAUDE.md:818-824` lists customer-PII-adjacent data as do-not-touch. This brief **creates a new, separate customer domain by Nick's explicit decision**; the existing rule still applies to everything outside `src/lib/customers*.ts` and the new tables.
- Migrations sequential, never edited once applied; highest cited on main is **0109**; two files named `0108_*` exist on disk (`0108_cashbox_count_moves.sql`, `0108_chain_orders.sql`) — check `git ls-files migrations/` on current `main` before numbering (`prs-crm/CLAUDE.md:721-732`). `migrations/seeds/*` is prod data — no fake rows.
- Tests: `npm test` = vitest (~17 min full); run touched files + `npm run typecheck` + `npm run build`; `npm run lint` is unusable. Integration tests `describe.skipIf(!hasDb)`.
- Nav: `src/lib/nav-config.tsx` `NAV_GROUPS`; OPERATE group starts with **Orders** (`/orders`).
- Twilio voice + SMS already exist in the CRM (`@twilio/voice-sdk`, `webhooks/*`) — the inbound caller's number is available in-app.
- Payout engine (`0062`, `0084`–`0086`, `src/lib/payout-*.ts`) consumes `fetchAccountingOrders()` from the bridge (`chain-orders.ts:3,71`). Anything the bridge stores as an order with money fields is payable.

**Bridge (pfd-order-monitor)**
- Only routes that create an `orders` row from the CRM side: `POST /api/crm/restaurants/:id/test-order` (fixed `source:'test'`) and `test_print`. **No generic ingest route and no menu route exist in the contract** (`contract:390-431`).
- Delivery to the restaurant is decided per order by `orderDestinations()` in `lib/canonical.ts` (printer poll 5 s / tablet push+poll / AEM email). `lib/canonical.ts`, ingest fate-sharing, `orders.status` semantics and `/api/crm/*` shapes are do-not-touch **without a contract update** (`dev/CLAUDE.md:42`) — this brief is that contract update.
- Zuppler orders arrive by webhook / Gmail poll; the contract mentions a "LoadOrder GraphQL selection set" (`contract:759`) → the bridge has *some* Zuppler GraphQL access. Base URL / auth / whether it can load **menus** or **create orders**: UNKNOWN.
- Actor must be passed explicitly (`actor` body field / `x-crm-actor`) — the bridge cannot know who asked.
- Restaurant mapping: CRM `accounts.id` == bridge `restaurants.crm_restaurant_id`; `restaurant.zuppler_restaurant_id` == CRM `zuppler_locations.zuppler_id`.

**Data Dreamers (observed 2026-09-18 in the PFD intranet, s988.securemenu.com)** — the parity target
- Order-entry header has four tabs: **Addr** (address + zip/city + map, driver for this order / this account, residence/business) → **Cust** (phone, first/last, "Secret" note, email, don't-auto-email, Auto Tip, Delivery Fee override, customer profile) → **Order** (restaurant for this order / permanent restaurant, Advance Order date-time, Takeout/Pickup/DineIn, No-Contact) → **Pmt** (tip $ + presets 10/12.5/15/18/20 %, Cash / Credit Card / House Account, Split Check). Left rail: restaurant picker + item search.
- Credit-card panel: number, month/year, CVV, cardholder name, **"Remember this card"** (default on), "Billing address same as delivery" (default on). So DD already vaults cards per customer — this is the behaviour to match.
- Site configuration: accepted tenders Cash, Visa/MC/Amex/Discover with **3.5 % card surcharge**, Gift Card, House Account (internal only), custom "one card" type; AVS decline options; default tax 9.75 %; suggested tip 18 % or $3 (greater); max payment splits 5; "Manually send YouMenu orders"; distance-based delivery fee schedules; delivery areas; auto-tips; CSR popups; prepaid/gift cards; house accounts.
- Which merchant account / gateway DD settles card payments to: UNKNOWN (not visible in Site Configuration; check DD "CC Report" and bank deposits).

**Zuppler Chef (observed 2026-09-18)**
- PFD's Chef account lists 256 restaurants and 48 channels, including a **"Willie Mae's AI Phone Ordering" channel at orderdirect.zuppler.com** — Zuppler supports non-website channels that inject orders, and has a **Customers** section (search by name/email/phone). Whether a partner can create orders via API into a channel: UNKNOWN (developer.zuppler.com blocks automated reads; ask Kate).
- Public Zuppler widget integration docs (`zuppler.github.io/online-ordering`) show menus are served from a per-channel JSON URL (`data-channel-url`) with `data-restaurant-id`; no order-placement API is documented publicly.

### FACT — how the two outside systems work today (observed 2026-09-18, logged in as PFD)

**Data Dreamers is not just order entry — it is PFD's whole delivery operating system today.** Modules seen on the intranet home:

| DD area | What it does (observed) | CRM has it? |
|---|---|---|
| Order entry header (Addr / Cust / Order / Pmt tabs + restaurant & item rail) | Phone-order builder: address + map + zip validation, customer profile w/ "Secret" note, per-order and permanent restaurant, advance order, takeout/dine-in, no-contact, tip presets, Cash / Card / House account, split check, card vault ("Remember this card") | **No** — this brief |
| Edit Menus/Vendors, Menu Sharing, D/L Menubook formats, Photo Approvals (230 pending), Pending Vendor Apps (35) | DD keeps its **own copy of every restaurant menu**, hand-edited (Regular Menu → categories → item name/price/description); photo approval queue; vendor self-signup apps | **No** — O3 replaces the hand-copied menu with a Zuppler snapshot (the main reason to leave DD: one menu, maintained once in Zuppler) |
| ACID dispatch board ("A Completely Interactive Dispatch") | Live board per location (Springfield / …): drivers online w/ zip zones, assigned orders (restaurant, order #, address, CARD/CASH, miles), unassigned pool "drag me to a driver", driver-app chat per driver, **Auto pilot**, **AI Plan**, quote timer + "quote padding", Map All / Dispatch Map, timers by age, Msg All | **Partial** — CRM has driver ops (0054), driver tasks, time clock, cash log; **no live assignment board, no auto-dispatch, no driver map, no quote timer**. Out of scope here; belongs to Workstream L (self-delivery / Shipday) |
| Driver App + Manage Drivers / Cell Phones / Employees | Driver login, per-driver zone, signatures on CC orders, tips at door, driver pay by distance schedule | **Partial** — driver profile/application (0078), Focus paycard ledger (0072); **no driver app** (Shipday is the planned replacement) |
| Manage Delivery Areas | Zip-based areas + uploaded polygons, sub-areas, **tax rate per area** (9.75 % / 9.9 %), auto-tip per area, vendors and customer counts per area, "block online until" | **No** — O4 needs at least tax + fee per area; polygon zones are phase 2 |
| Distance Based Delivery Fee Schedules | Named schedules (e.g. "2026": 0–4 mi $1.99 + $1.50/mi; 5–60 mi $6.99 + $1.00/mi; "CATERING MENU FEE" tiers $20–$125), assigned to a **restaurant** (what customer pays) or a **driver** (what driver is paid) | **Partial** — Numbers Checker mileage pay `(miles−5)×$0.75` lives in the master sheet; CRM has `deal_terms` (0060) and `revenue_streams` (0084); **no customer-facing distance fee engine** → O4 default flat fee, U5 |
| Manage House Accts, Prepaid/Gift Cards, Auto Tips, Price Levels, CSR Popups, Order Templates | B2B house accounts billed later, gift cards, forced tips, per-restaurant price mark-ups ("price levels"), scripted CSR pop-ups during order entry, reusable order templates | **No** — all phase 2; price levels matter if PFD marks up phone-order menu prices vs Zuppler (probe in O3) |
| Order Lookup / Customer Lookup | Order search by vendor, driver, area, dates, customer, tender, phone/online/app, cancelled, new customer, late; customer query builder over orders | **Partial** — `/orders` dashboard (M2) does date/restaurant; no customer dimension until O2 |
| Reports: Sales Snapshot, CC Report, Daily Cash-Out, Restaurant Report, Balance Sheet, Billing Statement, Sold Items | Card settlement report, daily cash-out per driver, per-restaurant statement | **Partial** — payout engine + statements (0062, 0097, payout-statements); **no CC settlement report** until O5/O6 |
| Customer-facing: order tracker, status notifications, online ordering site (robco.premiumfooddelivery.org), mobile app registration, Olark chat, Mad Mimi / ReferralCandy marketing | DD also hosts a PFD-branded consumer ordering site + app with tracker and SMS/email status | **No / not needed** — Zuppler is the consumer channel; tracker/notifications for phone orders are phase 2 |
| Accepted tenders | Cash, Visa/MC/Amex/Discover @ **3.5 % surcharge**, Gift Card, House Account (internal), custom "one card"; AVS decline rules; max 5 splits | **No** — O5 |
| Checkmate POS integration, Eatabit printers, Fax | Order forwarding to restaurant POS / cloud printers / fax | **Yes (better)** — bridge already delivers to Epson printers, the tablet app, and AEM email |

Observed live on the board: orders tagged `CARD - Channel` — Zuppler channel orders are flowing **into DD** for dispatch today. **Nick's decision (2026-09-18): DD is being retired; dispatch moves to Shipday, so the CRM must replace only manual order entry (+ menu copy + card vault).** The dispatch-board, driver-app, delivery-area/polygon and driver-pay rows in the table above are Shipday's job, not the CRM's; they are listed so nothing is lost by accident. What the CRM *does* need from those rows: tax rate and delivery fee per order (O4/U5) and a way to hand a phone delivery order to Shipday (O7).

**Zuppler Chef (chef.zuppler.com) is the org-level portal**; per-restaurant menus/orders live in the classic "Control panel" (admin) and refunds/edits in customer-service.zuppler.com (already linked from the CRM Order drawer). Chef sections: Restaurants (256; Live / Not published), Channels (48 — websites, apps, and an **AI Phone Ordering** channel at orderdirect.zuppler.com), Collections, Gift Cards, My Bank, **Customers** (org-wide search by name/email/phone → Zuppler already holds a customer directory for online orders), Discounts, Statements, **Order Workflows** (3 workflows: "Premium Food Delivery" w/ marketing automation on 239 restaurants; "WSO" without, on 41; "WSO Oder Zup" on 2), Delivery Services (empty for PFD), Reports (restaurant + channel). Things Zuppler has that the CRM does not: the customer directory, gift cards, discounts, per-channel reporting, and — if U1 is yes — an order-injection path that would make Option A the smaller build.

**customer-service.zuppler.com (observed 2026-09-18, a live PFD order)** — what PFD staff use today to handle a Zuppler order after it is placed:
- Lists: Live Orders (due ≤ 3 h, "Customer Connect" status on the card), Today's Upcoming, Upcoming 30 days, Cancelled, saved searches, Tip Reports (per period, per restaurant), Reviews, Statements; "Download Data" / "Count Orders" per list.
- Order detail: ID, state (CONFIRMED), service, customer (name/email/phone/address), restaurant, pickup + due times, **timeline** (order placed → confirmed → "delivery service accepted"), **Cancel order**, **Print Receipt**, tabs Order Details / **Payment** / Support / Order Source / Order Contents, per-line modifiers with prices, Order Updates, Order Feedback (rating), **Update** on service/address/due, Totals.
- Payment tab: **"Payment by Braintree"**, status paid, tender "Braintree as Credit Card", card **"Visa ending 8598"**, transaction id, processed time, **Edit Order**, **Full Refund**. → FACT: Zuppler's processor is **Braintree**; card vaulting per customer exists at least for Zuppler-placed orders (Chef → Customers). Whether PFD can charge a vaulted Braintree card from a CRM-created order is part of U1.
- Order Source tab: channel "Premium Food Delivery" (robco.premiumfooddelivery.org, permalink ec2dba22 — flagged "Order came from an invalid URL. Please review configuration!!!"), Integration remote id (`depotbarandgrill`), "Configure with Control Panel" → restaurants.zuppler.com/channels/<id>. Sample money for a $61.00 delivery order: delivery $12.25, service $8.54, tax $5.95, tip $9.15 — the fee/tax rules O4 must reproduce (U5) live in Zuppler, not DD.
- Gap: the CRM Order drawer already deep-links here ("Edit in Zuppler"); nothing to rebuild. A phone order under Option B would **not** appear here (no Braintree charge, no Zuppler order) — refunds/edits for those live only in the CRM (O4/O5). Under Option A they would.

### ASSUMPTION — Nick's intent, not yet in code
- A1. Card data is **never** stored in the CRM database. Only a gateway token + brand + last4 + expiry + billing zip are stored. Card entry uses the gateway's hosted field / iframe so the CRM server never sees a PAN (PCI SAQ-A scope).
- A2. Phone orders must reach the restaurant through the **same bridge path as Zuppler orders** (printer / tablet / email) and show on the Orders dashboard with `source: 'phone'`. No second delivery mechanism.
- A3. Phone orders must count in restaurant payouts and accounting like any other order.
- A4. Dispatchers and admins take orders; no new role.
- A5. Parity with DD is the goal, but the **MVP** is: lookup customer → pick restaurant → build order from menu with modifiers → order type + time → tip/fees → cash or saved card or new card → submit. House accounts, gift cards, split check, AVS rules, CSR popups are **phase 2**.
- A6. Data Dreamers keeps running until O6's parallel-run checklist passes; nothing in this brief turns DD off.

### UNKNOWN — probe before building, do not guess
- U1. **Zuppler order-creation API**: does Zuppler let PFD submit an order into a channel (like the AI phone channel does) with its own payment, or with Zuppler-processed payment? → **STOP item for Nick**: ask Kate/Itisha at Zuppler for (a) menu read API per restaurant, (b) order create API / call-center channel, (c) whether Zuppler can vault cards per customer and charge on later orders. Answer decides Option A vs B in §2.
- U2. What Zuppler GraphQL access the bridge already has (`lib/` client, env names, whether `LoadMenu`/equivalent exists). Probe in O1 step 1.
- ~~U3~~ **PARTLY RESOLVED (Nick, 2026-09-18): PFD will use its own, cheaper processor — not Zuppler's Braintree.** Still open: *which* processor. Candidates and what matters for O5 (verify current pricing before signing — rates change):
  - **Global Payments** (PFD already resells Genius POS): ask the Genius rep for interchange-plus card-not-present pricing on a PFD MID + GP API hosted fields / card tokenization. Best if the partnership pricing is good; otherwise no.
  - **Helcim**: published interchange+ 0.50 % + 25¢ card-not-present at ≤$50K/mo, no monthly fee, Customer Vault + API (helcim.com/pricing, read 2026-09-18). Cheapest published option for keyed/phone orders at PFD's likely volume.
  - **Stripe**: flat-rate (not cheapest), but self-serve test keys → the only one Claude Code can build against unattended. Use as the reference/dev implementation, not the fee-saving answer.
  - Zuppler's own gateway list (zuppler.com, read 2026-09-18): Braintree, Fullsteam, Talus, ZupPay, Worldpay, "custom integration on request". **Bigger win to ask about:** if Zuppler can point PFD's channels at a cheaper gateway, fees drop on *every* online order, not just phone orders — put this in the Kate/Itisha email.
  - Compliance check before go-live (UNKNOWN, verify with the chosen processor): card-brand surcharge rules cap surcharges (Visa 3 % in the US since 2023) and require registration/disclosure; DD's 3.5 % may already exceed the cap. O5 default drops to **3 %** with a per-account override, and the receipt/ticket must disclose it.
- U4. `lib/canonical.ts` `CanonicalOrderInput` full shape and whether the `source` column is an enum / check constraint that must admit `'phone'`.
- U5. How delivery fee, service fee, tax and card surcharge are computed for a phone order today in DD per restaurant/zone; whether the CRM's `deal_terms` (0060) or `revenue_streams` (0084) already carry any of these rates.
- ~~U6~~ **RESOLVED (Nick, 2026-09-18): Zuppler delivery orders reach Shipday through the Zuppler Order Workflow** (Chef → Order Workflows: "Premium Food Delivery" on 239 restaurants). Customer-service.zuppler.com confirms it per order: timeline line "Order Confirmed — The delivery service accepted the order. Sending the order to be prepared for delivery." The CRM only *receives* Shipday webhooks (`delivery_events`, 0051, capture-only) via `src/lib/shipday.ts`; nothing in either repo creates Shipday orders. Consequence: under **Option A** phone orders created in Zuppler get Shipday, Braintree payment, receipts and refunds for free; under **Option B** the CRM must create the Shipday order itself (O7).
- U7. Highest migration number on current `main` (≥0109; `0108` duplicated on disk).
- U8. Whether Data Dreamers can export the customer directory (names, phones, addresses, notes) and order history before cancellation, so O2 can seed customers instead of starting empty. Saved cards cannot move (tokens belong to DD's gateway) — every repeat caller is asked once more, then never again.

---

## 2. Architecture decision (Claude Code: read this before O1)

Two viable shapes. **Nick's fee decision (own processor, not Braintree) settles the payment leg on B.** What remains open on A is only whether Zuppler will *accept an order created by the CRM with payment already taken elsewhere* (tender "external/paid") — if yes, the CRM keeps O5 (own processor) and skips O3/O7 (menu, Shipday) because Zuppler's menu and Order Workflow do that work; if no, full B. Either way O2, O4, O5 are needed. Ask Zuppler both questions (order API with external tender; cheaper gateway for PFD's channels) in the same email.

- **Option A — Zuppler-native**: CRM calls Zuppler's API to read the menu and to *create the order in Zuppler* (as a "PFD call center" channel). Zuppler handles payment and the order arrives at the bridge via the existing webhook like every other Zuppler order. Least new code, perfect parity with payouts and refunds ("CRM shows, Zuppler edits"). **Blocked on U1.**
- **Option B — In-house**: CRM keeps a menu snapshot per restaurant (imported from Zuppler), takes payment through its own `PaymentProvider`, and POSTs the order to a new bridge ingest route which stores it with `source:'phone'` and delivers it through `orderDestinations()`. Works regardless of Zuppler's API. Refunds/edits happen in the CRM, not Zuppler.

Everything below is written for **B** with seams that let A replace O3 (menu source) and O7 (Shipday) without touching the UI: `MenuSource` and `OrderSubmitter` interfaces (`bridge` first; `zuppler` if U1 says yes). **O2 (customers), O4 (builder UI) and O5 (own-processor payments) are needed under both options** — start O2 and O4 now, O5 as soon as Nick names the processor and supplies sandbox keys (build the `stripe` reference implementation meanwhile). Hold O3 and O7 until Nick reports Zuppler's answer to U1, unless he says to proceed.

---

## 3. Packages

Order: **O1 (bridge) → O2 → O3 → O5 → O4 → O7 → O6** (CRM). O2/O3/O5 are independent of each other and can run in parallel clones once O1's contract is merged; O7 can start its probe any time.

### O1 — Bridge: phone-order ingest + menu read (pfd-order-monitor)
Branch `feat/o1-phone-order-ingest`.

Facts to establish first (commit evidence in the PR description, `prs-crm/CLAUDE.md:806-811`):
1. Read `lib/canonical.ts`: `CanonicalOrderInput`, the insert helper the Zuppler/email ingest uses, and how `source` is constrained. Read the Zuppler GraphQL client (grep `LoadOrder`) for env names and available queries (U2).

Build:
2. `POST /api/crm/orders` — Bearer `CRM_WRITE_KEY`; body `{ restaurant_id (bridge id) | crm_restaurant_id, source: 'phone', external_id (CRM phone_order id, idempotency key), order_type: 'delivery'|'pickup', due_time|null (asap), customer: {name, phone, address?, address2?, notes?}, items: [{name, price, qty, modifiers: [{name, price}], notes?}], money: {subtotal, tax, delivery_fee, service_fee, tip, discount, surcharge, total}, payment: {type: 'cash'|'card'|'house', status: 'paid'|'due', last4?}, notes, actor }`. Zod-validate. Idempotent on `(source, external_id)` — a retry returns the existing row, 200 not 201. Insert through the same canonical helper Zuppler ingest uses so `orderDestinations()`, print jobs, tablet push and `orders.status` semantics are untouched. Return the list-row shape from `contract:533-597` plus `id`.
3. If `source` is constrained, add a migration admitting `'phone'`. Ticket/print template must show **PAID — CARD ••1234** or **CASH DUE $xx.xx** on the printed/tablet ticket (restaurants must know whether to collect), and must not show "Zuppler".
4. `GET /api/crm/restaurants/:id/menu` — **only if** step 1 found a Zuppler menu query. Return `{ restaurant_id, zuppler_restaurant_id, fetched_at, categories: [{id, name, items: [{id, name, description, price, modifier_groups: [{id, name, min, max, options: [{id, name, price}]}], available: bool}]}] }`. If no menu query exists, document that in the PR and in the contract as "menu source: none — CRM imports by other means" and skip; O3 falls back.
5. Update `docs/crm-bridge-contract.md` with both routes (or the one route + the finding), including error codes: `409` duplicate external_id with different payload, `422` unknown restaurant, `503` misconfigured key.

Tests: unit for zod + idempotency; integration (skipIf no DB) that a phone order for a printer-only restaurant queues a print job and for a tablet restaurant creates the push, exactly as a Zuppler order does; snapshot of the printed ticket text showing the PAID/CASH DUE line.

Acceptance: `curl` a phone order against dev → it appears in `GET /api/crm/orders?date=today` with `source:'phone'`, prints on a dev printer / shows on a dev tablet, and a second identical POST does not duplicate.

### O2 — CRM: customers domain (prs-crm)
Branch `feat/o2-customers`. Migration `NNNN_customers.sql` (next free number on `main`, U7).

Tables:
- `customers` (id, first_name, last_name, primary_phone E.164 unique, email, notes /* DD "Secret" */, default_tip_pct, do_not_email bool, created_by, created_at, updated_at, deleted_at).
- `customer_phones` (customer_id, phone E.164, label) — lookup index on phone.
- `customer_addresses` (id, customer_id, line1, line2, city, state, zip, lat, lng, delivery_notes, is_business bool, is_default bool).
- `customer_payment_methods` (id, customer_id, provider text, provider_customer_ref text, provider_token text, brand, last4, exp_month, exp_year, billing_zip, is_default, created_by, created_at, revoked_at). **CHECK that no column can hold a PAN** — add a comment and a unit test asserting the zod insert schema rejects 13–19 digit strings in every text column.
- `customer_restaurant_prefs` (customer_id, account_id, last_ordered_at, order_count) — powers "permanent restaurant".

Code: `src/lib/customers.ts` (create/find-by-phone/merge/update, `CustomerNotFoundError`, `DuplicatePhoneError`), `src/lib/customers-shared.ts` (pure types/formatters), access predicate `canTakeOrders(roles)` = admin | dispatcher in `src/lib/orders-access.ts` (extend, don't duplicate). Routes: `GET /api/customers?phone=`, `POST /api/customers`, `PATCH /api/customers/:id`, `POST /api/customers/:id/addresses`, `DELETE /api/customers/:id/payment-methods/:pmId` (revoke = set `revoked_at` + provider detach). Audit every read of a customer record into `admin_audit_log` (0102) with actor + reason `order_entry`.

Tests: phone normalisation (E.164, US default), lookup by any phone, merge, PAN-rejection test, access predicate parity test (page + API).

Acceptance: dispatcher can look up / create a customer by phone; caller role gets 403; admin sees audit rows.

### O3 — CRM: menu snapshot + import (prs-crm)
Branch `feat/o3-menu-snapshot`. Migration `NNNN_menus.sql`.

Tables: `menus` (id, account_id, source 'zuppler_bridge'|'zuppler_channel_json'|'manual', source_ref, fetched_at, is_current), `menu_categories`, `menu_items` (menu_id, category_id, external_id, name, description, price_cents, available, sort), `menu_modifier_groups` (item_id, name, min, max), `menu_modifier_options` (group_id, name, price_cents). Snapshots are immutable; a re-import creates a new `menus` row and flips `is_current`; `phone_orders` reference the snapshot row so history stays priced correctly.

`MenuSource` interface in `src/lib/menu-sources/`: `bridge` (O1 step 4 route, preferred), `channel-json` (fetch the Zuppler channel JSON URL stored per account — probe one live channel URL from Chef → Channels and document its shape; only if publicly fetchable without auth), `manual` (admin CSV upload, last resort). Cron `/api/cron/menu-refresh` daily 04:00 CT via `vercel.json` (auth `CRON_SECRET`), plus an admin "Refresh menu" button on the partner page (`/partners/[id]`, extend the existing page, don't fork it).

Tests: importer idempotency (same payload → no new snapshot), price change → new snapshot, unavailable items hidden in builder but kept in history.

Acceptance: at least 3 live restaurants have a current snapshot from a non-manual source, visible on the partner page with `fetched_at`.

### O5 — CRM: payments provider + tokenization (prs-crm)
Branch `feat/o5-payment-provider`. No migration beyond O2's table.

`src/lib/payments/provider.ts` interface: `createCustomer(customer) → providerCustomerRef`, `createSetupSession(providerCustomerRef) → {clientSecret|hostedUrl}` (card entered in the provider's hosted element in the browser, never posted to our server), `listMethods`, `charge({methodRef, amountCents, currency, idempotencyKey, description, metadata:{phone_order_id, account_id}}) → {chargeRef, status, failureReason?}`, `refund(chargeRef, amountCents, reason)`, `detach(methodRef)`. Implementations: the interface plus **two** providers — `stripe` (PaymentIntents + SetupIntents + Elements; self-serve test keys so Claude Code can build and test unattended; **dev/reference only, never the live provider unless Nick says so**) and **`helcim`** (decided 2026-09-19; STOP only until Nick supplies Helcim sandbox keys, expected the week of 2026-09-21 — then implement against HelcimPay.js hosted fields + Customer Vault + Payment API for charge/refund, field names copied from Helcim's docs into the PR). `PAYMENTS_PROVIDER` env selects at runtime; a provider without keys fails closed with a clear error at order submit, never a silent cash fallback. Env: `PAYMENTS_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` (names only in docs, never values). Webhook `POST /api/webhooks/payments` for async failures/disputes → opens a trouble ticket on the order's account (reuse `dispatch_tickets`, 0077).

Rules: every `charge` carries an idempotency key = `phone_order_id:attempt`; a card **surcharge** line (default **3 %**, per-account override, disclosed on ticket/receipt; see U3 compliance note) is a separate money field so payouts can exclude it; decline → order stays `draft`, nothing is sent to the bridge; refund from the Order drawer (admin only) reverses the charge and writes `phone_orders.refunded_cents`. Test mode keys only in dev; a unit test asserts the provider is mocked at the boundary (`prs-crm/CLAUDE.md:747-749`).

Tests: charge/decline/refund against the mocked provider; idempotency; surcharge math; webhook signature rejection.

Acceptance: in dev with Stripe test keys, save a `4242…` test card via the hosted element, see only brand/last4/exp in `customer_payment_methods`, charge it, refund it.

### O4 — CRM: order builder UI + submit (prs-crm)
Branch `feat/o4-phone-order-builder`. Migration `NNNN_phone_orders.sql`: `phone_orders` (id, account_id, customer_id, customer_address_id, menu_id, order_type, due_time, items jsonb (snapshot of chosen items/modifiers with prices), money jsonb, payment_method_id, payment_type, charge_ref, status 'draft'|'submitted'|'failed'|'refunded', bridge_order_id, external ticket link, taken_by, created_at, submitted_at), `phone_order_events` (audit timeline).

Page `/orders/new` (nav: a "New order" button on `/orders`, not a new nav item). Gate with `canTakeOrders`. Layout mirrors the DD tabs but as one screen, top to bottom:
1. **Phone** — input prefilled from the active Twilio call when one is up; lookup → customer card (name, notes, addresses, saved cards, last restaurants) or "New customer" inline form.
2. **Restaurant** — searchable list of live partners (roster ∩ accounts, as `/orders` does); default = customer's last restaurant; shows open/closed from bridge roster and whether the restaurant is live.
3. **Items** — category tabs from the current `menus` snapshot, item search, modifier groups enforcing min/max, qty, per-item notes; running cart on the right.
4. **Fulfilment** — Delivery (address picker from customer addresses + new address; zone/fee from U5 result) | Pickup; ASAP or scheduled date-time (advance order); No-contact flag; order notes.
5. **Payment** — tip presets (10/15/18/20 % + $), tender: Cash | Saved card (default card preselected) | New card (opens provider hosted element, "Remember this card" default on) | House (phase 2, hidden). Totals: subtotal, tax (rate per account, U5), delivery fee, service fee, card surcharge, tip, total.
6. **Submit** — server action: validate → charge (if card) → `OrderSubmitter.bridge` POST (O1) with `external_id = phone_orders.id` → store `bridge_order_id` → redirect to `/orders?order=<bridge id>`. Failure after a successful charge must **refund automatically** and show why; never leave a charged, unsent order (`prs-crm/CLAUDE.md:767-775` spirit).

Orders dashboard: rows with `source:'phone'` show a "Phone" chip, "Taken by <user>", the tender line, and (admin) a Refund action in the drawer; no "Edit in Zuppler" for them (drawer already gates on source).

Tests: builder reducer (pure, in `orders-shared.ts` or a new `phone-order-shared.ts`) for totals/tip/surcharge/min-max modifiers; route tests for submit with mocked provider + mocked bridge (charge-then-bridge-fails → refund called); E2E via `E2E_TEST_BYPASS=1` as a dispatcher.

Acceptance: a dispatcher places a real test order to a dev restaurant end-to-end in < 90 s of clicks; it prints/pushes; it shows on `/orders` as Phone; totals match DD for the same order within $0.01 for the three sample restaurants in the parallel-run sheet (O6).

### O7 — Shipday hand-off for phone delivery orders (Option B only; prs-crm)
Branch `feat/o7-shipday-create-order`. **Skip entirely if Option A lands** — the Zuppler Order Workflow already sends the order to Shipday.
1. Read `src/lib/shipday.ts` and the Shipday webhook route; confirm with Shipday which API key / endpoint PFD's plan allows. Record in the PR and in `docs/reference/`.
2. Extend `src/lib/shipday.ts` (don't add a second client) with `createOrder()` against Shipday's insert-order API (`POST https://api.shipday.com/orders`, `Authorization: Basic <SHIPDAY_API_KEY>` — confirm against Shipday's current docs; never guess field names, copy them from the docs into the PR): customer name/phone/address, restaurant name/address/phone, order number = CRM `phone_orders.id` short code, items, totals, tip, payment method (`CASH` vs `CREDIT_CARD` so the driver knows what to collect), expected pickup/delivery times, delivery instructions. Store `shipday_order_id` on `phone_orders`.
3. Call it from O4's submit **after** the bridge accepts the order, only for `order_type = 'delivery'`; failure → order stays submitted to the restaurant, a trouble ticket opens on the account ("Shipday create failed — dispatch manually"), and the drawer shows a **Retry Shipday** button (admin | dispatcher).
4. `delivery_events` matcher: events whose `shipday_order_id` matches a `phone_orders.shipday_order_id` get `account_id` and `matched_via = 'phone_order'` so the existing capture table finally has a matched path.
5. Zuppler orders keep reaching Shipday through Zuppler's workflow; this helper is for CRM-created orders only.

Tests: mocked Shipday client (payload snapshot from the docs), pickup orders never call it, failure path opens a ticket and leaves the order intact, matcher unit test.

Acceptance: a phone delivery order to a dev restaurant appears in the Shipday dashboard with the correct tender and addresses within 10 s of submit; a pickup order does not.

### O6 — Cutover: reporting, payouts, parallel run (prs-crm)
Branch `feat/o6-phone-order-reporting`.
1. Confirm `fetchAccountingOrders()` returns phone orders with `payment_type` and money fields; payout engine treats them like Zuppler orders except the **card surcharge is PFD revenue, not restaurant sales** (add to `revenue_streams` 0084 if that is where such lines live — probe). Dry-run (`payout-dry-run`) must show a phone order on a test restaurant.
2. Add a "Phone orders" section to the existing accounting/payout reports and to the dispatcher Daily brief (`0100`, count + tender split) — extend, don't add pages.
3. `docs/runbooks/phone-orders-parallel-run.md`: two-week parallel run — every DD phone order is re-keyed in the CRM to a sandbox restaurant (or with the bridge `include_test` flag) and totals compared daily; exit criteria: 0 delivery misses, totals within $0.01, card declines handled, refunds tested, Shipday hand-off verified on real delivery orders. Then Nick switches dispatchers and **cancels Data Dreamers** (export customer list + card-holder last4s + order history first — DD "Customer Lookup" / "Order Lookup" exports; U8 below).

Acceptance: payout dry-run and Daily brief both show phone orders; runbook committed.

---

## 4. Delivery rules
- Branch → edit → touched tests + `npm run typecheck` + `npm run build` → commit → push → `gh pr create` → CI green → squash-merge. Never push `main`, never `vercel --prod*`, never print `.env*` values (key names only).
- Bridge PR (O1) merges before any CRM PR that calls it; CRM code must degrade (feature-flag `PHONE_ORDERS_ENABLED`) if the bridge route 404s.
- Migrations sequential; check `main` first; never edit an applied migration; `migrations/seeds` = prod data only.
- No new roles; one access predicate per surface, shared by page and API.
- No PAN, CVV, or full track data in any table, log, error message, or test fixture — including `raw_payload`-style columns. Add a CI grep test for 16-digit sequences in `tests/` fixtures.
- Don't touch live dispatch tables, printer-bridge shapes beyond O1's contract change, Supabase Auth, `.claude/settings.json`.
- Commit trailer per repo `CLAUDE.md`.

---

## 5. Open questions for Nick (defaults in bold so Claude Code proceeds)
1. Which processor? **DECIDED 2026-09-19: Helcim.** Claude Code builds the `PaymentProvider` interface + `stripe` reference implementation in test mode first (never live), then the `helcim` implementation (HelcimPay.js hosted fields for card entry, Customer Vault for saved cards, Payment API for charge/refund — field names from Helcim's current docs, cited in the PR) as soon as Nick supplies sandbox keys (expected week of 2026-09-21). Authorize.net evaluated and rejected (all-in-one = flat-rate + $25/mo; gateway-only only makes sense with a separate cheap MID). Global Payments stays a fallback only if its written quote beats Helcim.
2. Card surcharge on phone orders? **3 % (not DD's 3.5 %) pending the surcharge-rule check with the chosen processor; per-account override; disclosed on the ticket.**
3. Tax rate source? **Per-account field defaulting to 9.75 % (DD default); U5 probe may replace with `deal_terms`.**
4. Delivery fee for phone orders? **Flat per-account fee field for MVP; distance-based schedule is phase 2.**
5. Who may refund? **Admin only.**
6. Should we ask Zuppler for an order API before O3/O7 start? **Yes — this is the gating question for O3/O7. Nick emails Kate/Itisha (STOP item). Claude Code proceeds with O1, O2, O4, O5 and holds O3/O7 until the answer; if Zuppler says yes, O3/O7 become a `zuppler` implementation of the same interfaces.** Ask Zuppler specifically: (a) menu read per restaurant, (b) create order into a channel (like the AI Phone Ordering channel does) with `service: delivery|pickup`, due time, items/modifiers, tip, (c) **tender "external / already paid" or cash** on such orders, since PFD will charge the card on its own processor, (d) whether such orders run the Order Workflow (→ Shipday) and show in customer-service like any other, (e) **which gateways PFD's channels can use instead of Braintree (Fullsteam, Talus, ZupPay, Worldpay, custom) and their rates** — the fee saving on every online order, not just phone.
7. House accounts / gift cards / split check? **Phase 2, not in this brief.**
8. Seed O2 customers from a Data Dreamers export? **Yes if DD exports CSV (U8); Claude Code writes `scripts/import-dd-customers.mjs` as part of O2, dry-run by default.**

---

## 6. QUEUE entries to add

**prs-crm `docs/briefs/QUEUE.md`** (Owner `prs-crm`, Status `open`, blocked-by noted in Item):
```
| **O2** | Customers domain — tables, lookup by phone, access predicate, audit. Brief §3 O2. | 2026-09-18-manual-order-entry.md | prs-crm | open |
| **O3** | Menu snapshot + import (bridge → channel JSON → manual). Blocked by O1 merge for the bridge source only. Brief §3 O3. | 2026-09-18-manual-order-entry.md | prs-crm | open |
| **O5** | PaymentProvider interface + Stripe impl + hosted card element + webhook. Brief §3 O5. | 2026-09-18-manual-order-entry.md | prs-crm | open |
| **O4** | /orders/new phone-order builder + submit to bridge. Blocked by O1, O2, O3, O5. Brief §3 O4. | 2026-09-18-manual-order-entry.md | prs-crm | open |
| **O7** | Shipday hand-off for phone delivery orders — probe how Zuppler orders reach Shipday today, extend src/lib/shipday.ts with createOrder, retry + ticket on failure, delivery_events matcher. Blocked by O4 for the call site; probe now. Brief §3 O7. | 2026-09-18-manual-order-entry.md | prs-crm | open |
| **O6** | Phone orders in payouts/Daily brief + parallel-run runbook + DD cancellation checklist. Blocked by O4, O7. Brief §3 O6. | 2026-09-18-manual-order-entry.md | prs-crm | open |
```

**pfd-order-monitor `docs/briefs/QUEUE.md`**:
```
| **O1** | POST /api/crm/orders phone-order ingest (idempotent, source 'phone', PAID/CASH DUE on ticket) + GET restaurants/:id/menu if a Zuppler menu query exists; contract update. Brief §3 O1. | 2026-09-18-manual-order-entry.md | open |
```

**STOP items (Nick, not Claude Code)**: email Kate/Itisha at Zuppler re menu API / order API / card vault (U1); decide processor + supply keys (U3); confirm which DD tender/fee settings to carry over (U5).
