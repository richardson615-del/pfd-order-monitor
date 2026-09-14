# Claude Code instruction package — Order Monitor tablet app: "Premium" brand, modern dashboard, always-on notifications

Paste this file into Claude Code opened at `C:\Users\richa\dev\pfd-order-monitor`. Read `README.md` and `docs/crm-bridge-contract.md` first. This is **Workstream C**, companion to `prs-crm/docs/briefs/2026-09-14-devices-redesign-and-login-print.md` (Workstreams A/B target the CRM; this one targets the restaurant-facing tablet app that lives in this repo).

Author: Nick Davies (Premium Restaurant Solutions). Date: 2026-09-14.

---

## 0. Scope in one paragraph

The restaurant tablet app (`/login`, `/dashboard`, `/order/[id]`) should (1) carry a **"Premium"** brand — a smooth, modern wordmark/logo on the login screen, dashboard header, PWA/TWA icon and notification icon; (2) get a **modern dashboard** with one unified design system, the **restaurant's name in the header**, and a **truthful live/offline indicator**; and (3) make **notifications always on** — no "Enable notifications" button, no optional state: the app does not let a restaurant use the dashboard until order alerts are enabled, re-subscribes itself silently whenever it can, and surfaces "alerts off" as a blocking condition, not a setting.

No changes to ingest, printing, CRM bridge routes, or the orders data model in this workstream.

---

## 1. Ground truth (verified from the repo on 2026-09-14)

Label key: **FACT** = read from code. **ASSUMPTION** = Nick's intent as interpreted. **UNKNOWN** = not visible; probe before building.

### Identity — FACT
- App is named "PFD Order Monitor" / short "PFD Orders" everywhere: `public/manifest.json`, `app/layout.tsx` metadata, `android/twa-manifest.json` (`name`, `launcherName`), `public/install.html`, login `<h1>` (`app/login/page.tsx:94`).
- **No logo is rendered anywhere in the app.** Login shows a plain text h1; the dashboard header (`components/OrderDashboard.tsx:256-277`) shows waiting count, Live/Connecting/Offline pill, clock, and the `PushSetup` button — **no app name, no restaurant name**.
- Icon `public/icons/icon-512.png`: flat blue (#4F8CFF) square, dark navy (#111827) rounded square, white bold "PFD". `icon-192.png` referenced but same style (ASSUMPTION). Used as PWA icon, TWA icon (`twa-manifest.json` points at hosted URL), and notification icon/badge (`public/sw.js:22-23`).
- "Premium" appears on screen nowhere; only on the printed login ticket (`lib/print-document.ts:155,165`). "Premium Food Delivery" only in manifest/metadata descriptions.
- `restaurantName` prop reaches `OrderDashboard` but is used only in the empty-state sentence (`:305`). Source: `restaurants.name` (`app/dashboard/page.tsx:35`).

### Stack & styling — FACT
- Next.js 14.2.15 App Router, React 18.3, no Tailwind, no UI library. One hand-written `app/globals.css` (~800 lines) with **two coexisting token sets**: legacy `:root` (`--bg #0f1420`, `--panel`, `--accent #4f8cff`…) used by login/order detail/admin, and a newer `.app` scope (`--app-bg #0b0d10`, `--app-accent #38bdf8`, `--age-*`, `--st-*`) used by the dashboard. Navigating dashboard → order changes background and accent color.
- System font stack only; no web fonts.
- `.card` is defined twice (legacy `:416` and dashboard `:559`) and both cascade onto the login "Check email" box. Legacy `.order-card`, `.tabs`, `.badge.status-*`, `.empty-state` classes are mostly dead; `.badge.status-*` still used by `OrderViewer.tsx:92` showing the **raw DB status string**.
- Kitchen vs Standard display via `data-display` on `.app` (`globals.css:685-779`), from `restaurants.display_mode` (migration 028). Keep both.
- `install.html` uses an unrelated light/red palette.
- Viewport `userScalable:false, maximumScale:1` (`app/layout.tsx:23-25`).

### Live/offline today — FACT
- The `.app-live` pill reflects **only the Supabase Realtime channel state** (`lib/kiosk.ts:99-114`). It does not reflect heartbeat or push subscription.
- Heartbeat: `POST /api/dashboard/heartbeat` every 2 min → `dashboard_heartbeats` one row per restaurant (migration 024). Server health marks `tablet_not_watching` when ≥15 min silent for `app_expected` restaurants with a recent order (`lib/health.ts:275-287`).
- Sound: Web Audio chime every 8 s while unaccepted orders exist; must be armed by a user gesture; critical banner "Sound is off — touch the screen…" when not armed (`kiosk.ts:170`).
- Clock uses device locale/timezone (`OrderDashboard.tsx:273`). UNKNOWN whether `restaurants` has a timezone column (CRM `accounts` does; not exposed in the bridge contract).

### Notifications today — FACT
- `components/PushSetup.tsx`: a small "Enable notifications" button in the header. On tap: `Notification.requestPermission()` → `pushManager.subscribe(...)` → `POST /api/push/subscribe` (upsert by endpoint into `push_subscriptions` with `restaurant_id = restaurantIds[0]`, `auth_user_id`).
- **Optional and forgettable**: nothing auto-prompts; nothing blocks the dashboard; on error the same button silently reappears with no message; state is `useState("idle")` so the button shows on **every page load even when already subscribed** — nothing reads `Notification.permission` or `pushManager.getSubscription()`; no `pushsubscriptionchange` handler in `sw.js`; no re-prompt logic.
- Subscription is per browser/service-worker endpoint and outlives sign-out (README). Health raises `restaurant_no_app_device` warning when an `app_expected` restaurant has zero `push_subscriptions`.
- Android: Bubblewrap TWA `com.pfdworks.orders`, `enableNotifications: true`, `startUrl /dashboard`, sideloaded APK from `/install.html` (`appVersion 1.0.1`, `appVersionCode 2`). Icon change ⇒ new APK build + version bump.

### Platform constraint — FACT (web platform, not this repo)
Browsers only grant `Notification.requestPermission()` from a **user gesture**, and once a user selects "Block", the page cannot re-prompt — the user must change it in Android/Chrome site settings. "Always on" therefore means: **the app never offers a way to skip or turn alerts off, requires one tap to grant on first run, silently keeps the subscription alive afterwards, and blocks the dashboard until granted.** It cannot mean "granted with zero taps on a fresh install."

### Login print (Workstream B, bridge side) — FACT
`app/api/crm/restaurants/[id]/logins/print/` exists, `lib/print-document.ts` builds the ticket, migration `029_print_documents.sql` adds `print_jobs.kind/document`, `scripts/test-login-print.ts` is in `npm test`, and the contract is documented in `docs/crm-bridge-contract.md:194-248`. Treat B-bridge as **done or in review** — do not redo it here; the CRM-side UI (B2 in the CRM brief) still consumes it. If C changes `SETUP_STEPS` wording (see C3), update `print-document.ts` step 3 accordingly.

---

## 2. Workstream C — deliverables

Order: C1 → C2 → C3, three PRs. C3 may start in parallel with C2 once C1 is merged (C3 reuses C1's tokens).

### C1 — Brand + design tokens (PR `brand/premium`)
**Intent — ASSUMPTION:** the on-screen brand becomes **"Premium"** (wordmark), the product name becomes **"Premium Orders"**, and "PFD" disappears from restaurant-facing text (restaurants know the company as Premium; PFD is internal). Confirm in §4 Q1.

1. **Wordmark component** `components/Brand.tsx` (server-safe): SVG/text lockup "Premium" — lowercase-friendly geometric sans, tight tracking, subtle gradient fill (accent → lighter accent), optional small caps "ORDERS" beneath. Props: `size: "sm"|"md"|"lg"`, `variant: "onDark"|"onLight"`. No external image; no raster. Provide a `Monogram` export ("P" in a rounded square with the same gradient) for tight spaces and as the source of truth for icons.
2. **Web font**: add one geometric sans via `next/font/google` (choose one of Plus Jakarta Sans, Manrope, or Outfit — pick the one whose "P" and "m" read cleanest at 40px; state the choice in the PR). Body stays system stack for speed; the font applies to `Brand`, headings, the waiting count and order numbers (`.num` keeps `tabular-nums`).
3. **Icons**: regenerate `public/icons/icon-192.png`, `icon-512.png`, add `icon-512-maskable.png` (`purpose: "maskable"`), and a monochrome `badge-96.png` for the notification badge, all from `Monogram`. Script `scripts/build-icons.ts` using `@napi-rs/canvas` (already a dependency) so icons are reproducible. Update `manifest.json` icons array, `sw.js` icon/badge paths, `layout.tsx` icons.
4. **Names**: `manifest.json` `name: "Premium Orders"`, `short_name: "Premium"`, description "Live order alerts for Premium restaurant partners"; `layout.tsx` title/appleWebApp.title; `install.html` copy; `twa-manifest.json` `name`/`launcherName` + bump `appVersion 1.1.0`, `appVersionCode 3` (APK rebuild is a manual step — list it in the PR body; do **not** run the Android build in CI).
5. **One token set**: collapse legacy `:root` and `.app` variables into a single palette on `:root`, keep the semantic names the dashboard already uses (`--age-*`, `--st-*`), add `--brand` (accent) and `--brand-2` (gradient end), define `--radius-*` and a 4-step type scale. Delete dead legacy classes (`.order-card`, `.tabs/.tab`, `.order-list`, `.order-source`, `.empty-state`) after grepping every usage; resolve the double `.card` by renaming the dashboard card to `.order` (update `OrderCard.tsx`). Login and order-detail pages move onto the same tokens (background/accent stop changing between screens). `install.html` gets the same palette.
6. Copy sweep: replace restaurant-facing "PFD" with "Premium" in `app/login/page.tsx`, `app/dashboard/page.tsx`, `install.html`. Leave `packageId com.pfdworks.orders`, hostnames, env names, and internal/admin text alone.
7. `npm run build:demo` after CSS changes (README rule) and commit the regenerated demo.

Acceptance: `npx tsc --noEmit` and `npm test` green; screenshots at 800×1280 (tablet portrait) of `/login`, `/dashboard` (kitchen + standard), `/order/[id]`, and the notification as rendered on Android; Lighthouse PWA "installable" still passes; no "PFD" string in any restaurant-facing screen (grep list in PR body).

### C2 — Dashboard redesign (PR `design/dashboard`)
No data-model change. Behaviors preserved: realtime + polling cadence, heartbeat, chime, wake lock, accept/complete/print flows, both display modes.

1. **Header** (sticky, two rows on kitchen / one row on standard):
   - Left: `Brand size="sm"`.
   - Center: **restaurant name** (`restaurants.name`) as the dominant text; below it on kitchen mode a one-line status sentence (see 2).
   - Right: **Status pill** (composite, see 2) + clock. Clock shows the restaurant's local time if a timezone is available (UNKNOWN — check `restaurants` columns; if none, add `restaurants.timezone text` in a new idempotent migration `030_restaurant_timezone.sql`, default `America/Chicago`, add to `REQUIRED_SCHEMA`, and expose it in the bridge `GET/POST /api/crm/restaurants` contract in a separate follow-up — do not block C2 on it; fall back to device time).
   - Remove the `PushSetup` button from the header entirely (C3 replaces it).
   - `document.title` = `"{Restaurant} — Premium Orders"`.
2. **Truthful status pill** — one `liveState()` pure function in `lib/kiosk.ts` with unit tests in `scripts/test-kiosk.ts`, inputs: realtime channel state, last successful sync age, heartbeat POST last ok age, push subscription present, audio armed. Output one of: `live` (green: channel live, sync fresh, push subscribed, audio armed), `degraded` (amber: any one of push/audio/heartbeat missing but orders still flowing — text names the missing thing), `offline` (red: channel down or sync stale). The pill label is the restaurant-facing word; the sentence under the name explains what to do ("Touch the screen to turn sound on", "Reconnecting — check wifi"). Keep the existing full-width red banner only for `offline`.
3. **Waiting count** becomes the hero on kitchen mode: number + "waiting" with the oldest order's age beside it ("oldest 7:32"). "All clear" state shows a calm check mark, not empty space.
4. **Tabs**: replace New/Opened/Completed/Printed with **Waiting / Accepted / Done** (Done = completed + cancelled + printed-and-settled) — matches the card flags in `order-display.ts`, which already hide the new/opened distinction. Keep a small "Show all" toggle. Cancelled orders get a visible strike style, not a hidden tab.
5. **Order cards** (`.order`): keep the age rail and breathe animation (reduced-motion respected); larger order number and customer name on kitchen; source shown as a small chip; total right-aligned; whole card is the tap target (already a `Link`).
6. **Order detail** (`OrderViewer.tsx`): same header component; status badge uses `orderFlag()` label, never the raw DB string; remove inline `style` spacing in favor of classes; action bar buttons sized for gloves on kitchen mode (≥64px).
7. Viewport: allow pinch-zoom (`userScalable: true`, drop `maximumScale`) unless kiosk testing shows accidental zooms — decide and record in the PR.

Acceptance: pure-function tests for `liveState()`; manual test log covering realtime drop, stale sync, push missing, audio unarmed; screenshots as in C1; no change to `/api/*`.

### C3 — Always-on notifications (PR `feat/alerts-required`)
**Intent — Nick, verbatim gist:** notifications are not an option; they are always on.

1. **Alert gate** `components/AlertGate.tsx` mounted inside `OrderDashboard` above everything:
   - On mount: read `Notification.permission` and `registration.pushManager.getSubscription()`.
   - **granted + subscription exists** → silently `POST /api/push/subscribe` (idempotent upsert keeps the endpoint fresh and re-binds it to the current `auth_user_id`/restaurant after a login change) → gate hidden. Also arm audio if possible; if audio needs a gesture, the existing banner handles it.
   - **granted + no subscription** (e.g., subscription expired or storage cleared) → subscribe silently, POST, gate hidden. No tap required.
   - **default (never asked)** → full-screen, non-dismissible overlay: `Brand`, restaurant name, "Turn on order alerts", one large button **"Turn on alerts"**. The tap is the required gesture: it calls `requestPermission()` → subscribe → POST → `armAudio()` in the same handler (one tap enables both push and sound). No close button, no "later", no way to reach the order list while the gate is up.
   - **denied** → same overlay, different copy: "Alerts are blocked on this tablet" with the exact Android/Chrome steps to allow them (Settings → Apps → Premium → Notifications, and Chrome site settings), a **"Check again"** button that re-reads permission, and the support number. Still non-dismissible.
   - **unsupported** (no `PushManager`, e.g. iOS Safari not installed to home screen) → overlay explaining to install the app to the home screen, with a link to `/install.html`.
   - Failures in subscribe/POST show the real error text in the overlay (today errors are swallowed) and retry with backoff; the overlay stays until success.
2. **Keep it on**: add `pushsubscriptionchange` handler in `sw.js` that re-subscribes with the VAPID key and POSTs to `/api/push/subscribe` (needs a route that accepts the SW's fetch — SW has no Supabase cookie by default; probe: cookies are sent for same-origin SW fetches with `credentials: "include"`; if the session cookie is unavailable, add a short-lived signed token stored by the page in `IndexedDB` for the SW — record the decision). Re-run the gate check on `visibilitychange` → visible and after every heartbeat (cheap `getSubscription()` call).
3. **Delete** `components/PushSetup.tsx` and its header usage; `install.html` step "Tap Enable notifications and allow it" becomes "Tap **Turn on alerts** when the app asks"; `lib/print-document.ts` `SETUP_STEPS[2]` → 'Tap "Turn on alerts" when it asks' (keep tests in `test-login-print.ts` in sync).
4. **Server signal**: no new health rule needed — `restaurant_no_app_device` already flags zero subscriptions. Add `push_subscribed: boolean` to the heartbeat POST body and store it as `dashboard_heartbeats.push_subscribed boolean` (idempotent migration `031_heartbeat_push_state.sql`, add to `REQUIRED_SCHEMA`) so the CRM can later show "tablet open but alerts off" per restaurant. Bridge contract change (exposing it via `GET /api/crm/restaurants`) is a separate follow-up PR, bridge-first.
5. Tests: `scripts/test-alert-gate.ts` — pure decision function `alertGateState({permission, hasSubscription, supported})` → `hidden|ask|blocked|unsupported`; regex-assert that `OrderDashboard.tsx` no longer imports `PushSetup` and that `sw.js` contains `pushsubscriptionchange`. Add both to `npm test` in `package.json`.

Acceptance (on a real Android tablet with the TWA): fresh install → login → gate appears → one tap → notifications and chime both work → reload → **no gate, no button**; clear site data → reload → gate reappears; block in Android settings → gate shows blocked copy and "Check again" works after re-allowing; a test order from the CRM ("Test order") triggers a system notification with the new icon and the on-screen chime.

---

## 3. Delivery rules for this package
- Branches: `brand/premium`, `design/dashboard`, `feat/alerts-required`. PR per branch, CI green (`tsc --noEmit` + `npm test`), squash-merge. `main` deploys to Vercel.
- Migrations: hand-pasted SQL, idempotent (`if not exists`, named constraints in `do $$` blocks), every schema-relied-on migration listed in `REQUIRED_SCHEMA` (`lib/schema-check.ts`). Never edit an applied migration.
- Do not touch: ingest, `orderDestinations()` in `lib/canonical.ts`, `orders.status` semantics, `print_jobs` writers, any `/api/crm/*` shape (contract changes are their own bridge-first PR), `lib/usernames.ts` domain constant.
- Never print `.env*` values. Do not run the Android build in CI; list the manual APK rebuild step in the C1 PR body.
- When an UNKNOWN in §1 resolves differently than assumed, update your plan comment and proceed if cosmetic; otherwise stop and ask Nick the smallest question.

## 4. Open questions for Nick (defaults in bold if unanswered)
1. Product name: **"Premium Orders"** (wordmark "Premium") vs keep "Order Monitor" with a Premium logo.
2. Brand color: **keep the current sky-blue accent (#38bdf8) as `--brand`** vs a new color you specify (hex).
3. Wordmark style: **text lockup generated in code** (fast, crisp at any size) vs a logo file you supply.
4. Pinch-zoom on the tablet: **keep disabled** (kitchen kiosk) vs allow.
5. Blocked-permission case: **hard block with instructions** (as specified) vs allow the dashboard through with a persistent red banner. (Nick's instruction "it should always be on" implies the hard block.)
