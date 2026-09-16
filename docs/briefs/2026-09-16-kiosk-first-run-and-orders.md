> **Status (2026-09-16, session 2):** I1 on `feat/kiosk-device-binding` (supersedes the earlier `feat/kiosk-first-run` #59 — Wi-Fi UI removed, 1b built: 1b-i managed config + 1b-ii ANDROID_ID in one shell, 1c kept; CRM push instead of bridge pull, see `docs/kiosk.md`). Shell changes made, **APK not rebuilt** — Nick to say when. I2 on `feat/orders-two-state` with the bold defaults (chime stops on open; Orders drop after 6 h; Past week counts + totals). CRM half in `prs-crm` `feat/tablet-link`. Open: verify Hexnode's serial wildcard in App Configuration on the trial tablet.

# Claude Code instruction package — Workstream I: kiosk first-run + simplified order flow (`pfd-order-monitor`)

Author: Nick Davies. Date: 2026-09-16. Obey `README.md`; repo rules win — stop and say so. Design reference: the "Premium Orders Kiosk" canvas (7 screens; the Wi-Fi screen was removed 2026-09-16) Nick has in Claude — Claude Code cannot open it, so the specs below are the source of truth; ask Nick for PNG exports if a layout question can't be settled from text.

Supersedes/adjusts Workstream C where they differ: C2's tabs (Waiting/Accepted/Done) → **Orders / Completed / Past week**; C3's alert gate stays but is folded into the first-run flow below.

## Nick's decisions (2026-09-16)
1. **The restaurant touches nothing but the kiosk's Wi-Fi button (provided by Hexnode, not our app).** No login, no pairing, no toggles at the store. The tablet is bound to its restaurant before it ships or automatically on first boot.
2. **No Accept step.** Two lists: **Orders** (everything currently in the kitchen) and **Completed**. One action on a ticket: **Done**. Plus a read-only **Past week**.
3. Kiosk mode is the only mode: the app is the whole screen, always.

## 1. Facts (from code 2026-09-14/15)
- Statuses today: `new | opened | completed | printed | cancelled` + `accepted_at`. Opening `/order/[id]` sets `opened`. Accept → `PATCH /api/orders/:id {accepted:true}`; complete → `{status:"completed"}`. Chime repeats every 8 s while `unaccepted(orders)` (not accepted, not completed/cancelled, <6 h old).
- `display_mode` kitchen|standard exists (migration 028).
- Login is Supabase username/password; session cookie via `@supabase/ssr`; heartbeat every 2 min; realtime per restaurant.
- Tablet is a TWA (`com.pfdworks.orders`), `startUrl /dashboard`, portrait, MDM-managed (Hexnode pending). Zero-touch tablets run Android's own first-boot Wi-Fi step before enrolment; QR-enrolled tablets are set up on Premium's Wi-Fi at the office and later need the store's Wi-Fi.
- FACT (Nick, 2026-09-16): Hexnode's kiosk exposes a Wi-Fi button to the restaurant, so the app needs no Wi-Fi UI. FACT (Android): apps cannot read the hardware serial on Android 10+ without privileged permission. UNKNOWN: whether Hexnode App Configuration offers a serial wildcard for managed-config values (I1 1b-i) — probe on the trial tablet.

## I1 — First run: the tablet already knows its restaurant (PR `feat/kiosk-device-binding`; small CRM PR `feat/tablet-link`)

**Change 2026-09-16 (Nick, after the Hexnode call):** Hexnode's kiosk gives the restaurant a Wi-Fi button on screen, so the app has **no Wi-Fi screen at all** — remove any in-app Wi-Fi UI from this plan and from C3/C4. The restaurant's only touch is that kiosk Wi-Fi button. The remaining requirement: **a tablet boots straight into its restaurant with no login screen.** Nick's Hexnode trial tablet is currently sitting at the login page and must be bound to Willie Mae's.

1. **Binding model.** A physical tablet (serial) is assigned to a restaurant in the CRM (D2 `tablets.account_id`). The app must resolve its own serial → restaurant on boot and get a session for that restaurant's tablet login without anyone typing. Mechanisms, in order:
   - **Nick's pick (2026-09-16): 1b.** Build 1b-i; fall back to 1b-ii if Hexnode lacks the wildcard; keep 1c as last resort. Do **not** try to read the hardware serial from the app — `Build.getSerial()` is privileged on Android 10+ and unavailable to anything but the device-owner agent.
   - **1b-i. Managed app configuration (preferred).** The TWA shell declares an Android Enterprise managed-configuration key `device_ref` (`res/xml/app_restrictions.xml` + `<meta-data android:name="android.content.APP_RESTRICTIONS">`). Hexnode's App Configuration for `com.pfdworks.orders` sets it per device using their serial-number wildcard (UNKNOWN — verify on the trial tablet; document the exact wildcard). The shell's launcher activity reads `RestrictionsManager.getApplicationRestrictions()` and opens `startUrl + "?device=" + device_ref`. Bridge `POST /api/kiosk/bootstrap {device_ref}` maps it to the restaurant assigned in CRM `tablets` (bridge asks CRM `GET /api/tablets/by-ref/:ref` with `CRM_WRITE_KEY`; CRM stores `tablets.device_ref` = serial from the MDM sync) and returns a session for that restaurant's tablet login. Rate-limit, log every bootstrap, refuse unknown refs with the 1c screen.
   - **1b-ii. Self-registration (fallback).** Shell generates a stable per-install id (`Settings.Secure.ANDROID_ID`, no permission) and passes it as `?device=`. Unknown ids appear in CRM Devices → Tablets as **"New tablet seen 2 min ago · <model> · Assign to…"**; assigning writes `tablets.device_ref` and the tablet's next bootstrap poll (every 5 s while unbound) gets its session. One click at the office, nothing typed on the tablet.
   - **Shell change is one APK rebuild**, same signing key, folded into the C1 Premium-brand rebuild: Bubblewrap-generated project → add a small `LauncherActivity` subclass that computes the URL, keep everything else stock. Bump `appVersionCode`.
   - **1c. Link code (`Pairing` design).** Tablet has connectivity but no session and no serial → shows a 6-digit code (30-min TTL, bound to a device fingerprint) + "Call Premium". CRM Tablets page: **Link tablet** → enter code → pick restaurant → bridge mints the session, tablet polls `GET /api/kiosk/link-status?code=` every 5 s. Endpoints: bridge `POST /api/kiosk/link-code`, CRM-authenticated `POST /api/crm/tablets/link {code, restaurant_id}`. Never show a username/password field on the tablet.
2. **Sessions never expire in practice.** Set the Supabase project's refresh-token settings so a kiosk stays signed in indefinitely under continuous use (no inactivity timeout, no time-boxed sessions); document the exact dashboard settings. Cache `restaurant_id` + name in `localStorage` so the header paints offline.
3. **Ready screen (`Ready` design):** first boot after binding: "You're all set, {restaurant}" with real checks — Wi-Fi/online, Order alerts on (C3's one-tap gate happens here if needed), Kitchen printer online (row omitted if no printer). **Send me a test order** button; auto-advance to Orders after 20 s.
4. **Offline screen (`Offline` design):** red banner, existing orders still listed dimmed, line "To change networks, use the Wi-Fi button at the bottom of the screen" (that's the Hexnode kiosk control — do not draw our own).
5. `/login` becomes Premium-staff-only (hidden from the kiosk; used once at the office if 1a–1c are all unavailable for a unit).

**Today, for the trial tablet at Willie Mae's (manual, no code):** in the CRM go to Devices → Willie Mae's → Logins → **Show password** (or **Add a login** if none) and sign in once on the tablet. The session persists across reboots and kiosk relaunches, so from then on it boots straight to Orders. Record the tablet's serial against Willie Mae's in Devices → Tablets (D2) so the automatic binding above picks it up when it ships.

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
- A tablet assigned to a restaurant in the CRM, freshly enrolled by Hexnode, powered on at the store: joins Wi-Fi via the kiosk button → shows Ready with real checks → Orders. **No login screen, no typing other than the Wi-Fi password in the kiosk's own Wi-Fi dialog.**
- Tablet with lost session shows the link code; entering it in the CRM links it within 10 s; no credentials ever displayed on the tablet.
- Test order: chime + NEW pill until the ticket is opened; Done moves it to Completed with the right time and total; Past week shows correct per-day counts against the DB.
- Screenshots at 800×1280 of all seven states in the PR body; `npm test` green with new tests for `unseen()`, bucket derivation, per-day aggregation in a non-UTC timezone.

## Open questions for Nick (defaults in bold)
1. Chime stops when the ticket is **opened** (tap) — or only when Done? (Opened keeps the kitchen from being nagged while cooking.)
2. Orders drop off the Orders list after **6 h** without Done — or stay until Done, forever?
3. Past week visible to restaurant staff: **yes, read-only, counts + totals** — or hide totals?
