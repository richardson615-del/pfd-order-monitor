> **Status (2026-09-16):** I1 shipped as PR `feat/kiosk-first-run` (see `docs/kiosk.md`). Open: the Wi-Fi hand-off probe on the trial tablet (I1.4 — needs the Hexnode kiosk policy, which Claude Code cannot reach; (a) is shipped, (c) documented). I2 on `feat/orders-two-state`. CRM half (Link tablet) in `prs-crm` PR `feat/tablet-link`.

# Claude Code instruction package — Workstream I: kiosk first-run + simplified order flow (`pfd-order-monitor`)

Author: Nick Davies. Date: 2026-09-16. Obey `README.md`; repo rules win — stop and say so. Design reference: the "Premium Orders Kiosk" canvas (8 screens) Nick has in Claude — Claude Code cannot open it, so the specs below are the source of truth; ask Nick for PNG exports if a layout question can't be settled from text.

Supersedes/adjusts Workstream C where they differ: C2's tabs (Waiting/Accepted/Done) → **Orders / Completed / Past week**; C3's alert gate stays but is folded into the first-run flow below.

## Nick's decisions (2026-09-16)
1. **The restaurant's only setup step is Wi-Fi.** No login, no pairing, no toggles at the store. Everything else is done by Premium before the tablet ships or automatically.
2. **No Accept step.** Two lists: **Orders** (everything currently in the kitchen) and **Completed**. One action on a ticket: **Done**. Plus a read-only **Past week**.
3. Kiosk mode is the only mode: the app is the whole screen, always.

## 1. Facts (from code 2026-09-14/15)
- Statuses today: `new | opened | completed | printed | cancelled` + `accepted_at`. Opening `/order/[id]` sets `opened`. Accept → `PATCH /api/orders/:id {accepted:true}`; complete → `{status:"completed"}`. Chime repeats every 8 s while `unaccepted(orders)` (not accepted, not completed/cancelled, <6 h old).
- `display_mode` kitchen|standard exists (migration 028).
- Login is Supabase username/password; session cookie via `@supabase/ssr`; heartbeat every 2 min; realtime per restaurant.
- Tablet is a TWA (`com.pfdworks.orders`), `startUrl /dashboard`, portrait, MDM-managed (Hexnode pending). Zero-touch tablets run Android's own first-boot Wi-Fi step before enrolment; QR-enrolled tablets are set up on Premium's Wi-Fi at the office and later need the store's Wi-Fi.
- UNKNOWN: whether a TWA page can open the Android Wi-Fi picker via an `intent:` URL (`intent:#Intent;action=android.settings.WIFI_SETTINGS;end`) under the Hexnode kiosk policy; whether Hexnode's kiosk offers a Wi-Fi peripheral button. Probe on the trial tablet first (I1.4).

## I1 — First run: Wi-Fi is the only step (PR `feat/kiosk-first-run`)
1. **Restaurant binding before shipping.** Premium signs the tablet in at the office with the restaurant's tablet login (E1 creates it). Make that session effectively permanent: set the Supabase project's refresh-token expiry/reuse so a kiosk stays signed in for at least 1 year of continuous use (document the exact setting; UNKNOWN which plan limits apply). Store `restaurant_id` + name in `localStorage` as a cache so the header renders instantly offline.
2. **Wi-Fi screen (in-app, `SetupWifi` design):** shown when the app has no connectivity **and** has never completed setup on this device (`localStorage.setupDone` absent), or when a QR-enrolled tablet first boots at the store. Copy: "Connect this tablet to your Wi-Fi — That's the only thing to set up." One button **Choose Wi-Fi network** → opens the Android Wi-Fi picker (I1.4). The in-app network list/password field in the mockup is illustrative of the *Android* picker; do **not** build a web Wi-Fi UI (a web page cannot join networks).
3. **Ready screen (`Ready` design):** after connectivity returns and the session is valid: "You're all set, {restaurant}" with three checks read from real state — Wi-Fi connected (online), Order alerts on (C3 gate satisfied — if not, the gate's one tap happens here, as the last step of the same screen), Kitchen printer online (bridge `has_active_printer` + device online; omit the row if the restaurant has no printer). Button **Send me a test order** → existing `test-order` endpoint. Auto-advances to Orders after 20 s or on tap.
4. **Probe & decide the Wi-Fi hand-off** (write the answer into `docs/kiosk.md`): (a) `intent:` URL from the TWA; (b) Hexnode kiosk "Wi-Fi settings" peripheral; (c) MDM-pushed Wi-Fi profile collected during onboarding (fallback — restaurant gives PFD the password on the go-live call). Ship (a) or (b); document (c) as the escape hatch.
5. **Pairing fallback (`Pairing` design):** if the tablet has connectivity but **no valid session** (never bound, or session lost), show a 6-digit **link code** (server-issued, 30-min TTL, bound to device fingerprint) and "Call Premium". CRM side (small PR in `prs-crm`, D2 Tablets page): **Link tablet** → enter code → choose restaurant → bridge mints a session for that device. Endpoints: bridge `POST /api/kiosk/link-code` (unauthenticated, rate-limited, returns code), `POST /api/crm/tablets/link {code, restaurant_id}` (CRM-authenticated), tablet polls `GET /api/kiosk/link-status?code=` every 5 s until linked. Never show a username/password field on the tablet again.
6. **Offline screen (`Offline` design):** red banner "Not receiving orders — Wi-Fi is down · reconnecting since 6:39 PM", button **Choose Wi-Fi network**, existing orders still listed (dimmed) so the kitchen can finish them, footer "Premium has been notified automatically" (bridge health already raises `tablet_not_watching`).
7. Delete `/login`'s restaurant-facing use: keep the route for Premium staff only (admin flag), hide it from kiosk navigation.

## I2 — Orders / Completed / Past week (PR `feat/orders-two-state`)
1. **Model:** keep the DB statuses (printing and accounting depend on them — README rule) but the UI derives two buckets: **Orders** = not completed/cancelled and received within 6 h; **Completed** = completed today (restaurant local day, D1 timezone). `accepted_at` is no longer set by the UI; leave the column and the PATCH path for now (dead code removal later).
2. **Chime:** replace `unaccepted()` with `unseen()`: chime every 8 s until the order's ticket has been **opened** on this tablet (`opened_at` set) — opening is the acknowledgement. Orders older than 6 h stop chiming regardless (unchanged).
3. **Orders screen (`Main` design):** header (Premium wordmark small + restaurant name large + Live pill + clock); tabs **Orders n · Completed n · Past week** (64 px tall, active = light pill); hero line "**3** orders in the kitchen · oldest 11:32" (red when any order is late); cards oldest-first: 12 px age rail (calm/amber/late as today), `#number`, PICKUP/DELIVERY, NEW pill until opened, m:ss timer right, customer name uppercase 24 px, total right, one line of items (first 3 + "…"), no source label. Empty state: "All clear" with a check.
4. **Ticket (`OrderDetail` design):** back, PICKUP · ORDERED time, `#number`, big timer, customer, pickup/delivery time, line items with modifiers in amber, total, customer note + phone, footer buttons **Print again** (200 px) and **Done** (green, ≥96 px tall, fills the rest). Done → `status: completed` → returns to Orders.
5. **Completed (`Completed` design):** hero "**14** completed today · $612.40"; rows: green dot, `#number`, name + kind, total, "Done 6:29 PM"; tap → ticket (read-only, Print again allowed).
6. **Past week (`PastWeek` design):** 7 day tiles (Wed…Today) with count + $; selected day lists its orders newest-first; footer note that older history lives in the Premium statement. Data: `orders` for `restaurant_id` where `received_at >= now() - 7 days`, computed server-side per day in the restaurant's timezone; totals from `orders.total`. Cap 500 rows/day; page if more.
7. **Auto-complete safety net:** an order still in Orders 6 h after receipt drops off the list (unchanged behaviour) but is **not** marked completed — it simply ages out; Past week shows it with status as-is. Don't fabricate completion.
8. Remove the New/Opened/Printed tabs and the "Accept order" button; remove `orderFlag()`'s "Accepted" branch; update `lib/order-display.ts` tests.

## Acceptance
- Fresh QR-enrolled tablet powered on at a store with no known Wi-Fi: shows the Wi-Fi screen → one tap opens the Android picker → after joining, shows Ready with three real checks → Orders. **No typing on the tablet other than the Wi-Fi password.**
- Tablet with lost session shows the link code; entering it in the CRM links it within 10 s; no credentials ever displayed on the tablet.
- Test order: chime + NEW pill until the ticket is opened; Done moves it to Completed with the right time and total; Past week shows correct per-day counts against the DB.
- Screenshots at 800×1280 of all seven states in the PR body; `npm test` green with new tests for `unseen()`, bucket derivation, per-day aggregation in a non-UTC timezone.

## Open questions for Nick (defaults in bold)
1. Chime stops when the ticket is **opened** (tap) — or only when Done? (Opened keeps the kitchen from being nagged while cooking.)
2. Orders drop off the Orders list after **6 h** without Done — or stay until Done, forever?
3. Past week visible to restaurant staff: **yes, read-only, counts + totals** — or hide totals?
