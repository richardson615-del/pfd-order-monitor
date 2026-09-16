# The kiosk: first run, sessions, Wi-Fi, pairing

Workstream I1 (`docs/briefs/2026-09-16-kiosk-first-run-and-orders.md`).
Nick's rule, 2026-09-16: **the restaurant's only setup step is Wi-Fi.** No
login, no pairing, no toggles at the store. Premium does everything else
before the tablet ships, or the app does it by itself.

## What a tablet shows before the order list

Four states, decided by `firstRunScreen()` in `lib/first-run.ts`:

| network | session | set up on this device | screen |
|---|---|---|---|
| no | – | no | **Wi-Fi** — `public/offline.html`, served by the service worker |
| no | – | yes | **Offline** — same page, red strip, restaurant's name |
| yes | no | – | **Pairing** — `/link`, a six-digit code for the office |
| yes | yes | no | **Ready** — `components/ReadyScreen.tsx`, three checks, then the orders |
| yes | yes | yes | **Orders** |

"Set up on this device" is `localStorage["premium.setupDone"]`, written the
first time the Ready screen finishes. The keys live in `lib/kiosk-cache.ts`;
`offline.html` reads the same names by hand because it cannot import
anything (it is the page for when nothing loads).

The Ready screen's ticks are read, never assumed: Wi-Fi from the
dashboard's own connection state, order alerts from the same hook the alert
gate uses (`components/useAlertGate.ts` — if they are off, the one tap
happens here as the last step of setup), the kitchen printer from
`GET /api/dashboard/status`, which uses the same silence threshold the
health checks alarm on. No printer → no row. **Send me a test order** calls
`POST /api/dashboard/test-order`, the same `lib/test-order.ts` the CRM
button uses. The screen moves on 20 s after everything is green, or on tap;
never while alerts are off.

## Sessions that outlive a year on a wall

Premium signs the tablet in at the office with the restaurant's tablet
login (created by E1's provision call, or found by `ensureTabletLogin()`).
That session has to survive a year of continuous use, power cuts, and
weeks of being offline. What keeps it alive and what would kill it:

- **The browser client refreshes it.** `@supabase/ssr`'s browser client
  (`lib/supabase-browser.ts`) has `autoRefreshToken` on; the dashboard tab
  is open all day, so the access token (1 h) is refreshed on schedule. The
  middleware refreshes it on every protected request too, so a tablet that
  slept through several expiries refreshes on its first page load back.
- **Refresh tokens do not expire on their own.** Supabase rotates them on
  use and keeps the family valid indefinitely unless one of two project
  settings is on. Both must stay **off** for this project:
  - Authentication → Sessions → **Time-box user sessions**: *never* (the
    default). Turning this on signs every tablet out on a schedule.
  - Authentication → Sessions → **Inactivity timeout**: *never* (the
    default). A tablet off for the winter holidays would otherwise come
    back to the Pairing screen.
  - Authentication → Sessions → **Refresh token reuse interval**: leave at
    the default 10 s. Two tabs refreshing at once (the dashboard and a
    ticket) need the grace window.
- **What still ends a session:** the login's password being reset (E1 never
  resets one; the CRM's "reset password" does and says so), the user being
  deleted, or Chrome's site data being cleared by an MDM policy. All three
  land the tablet on the Pairing screen, which is the recovery path — not a
  failure state.

UNKNOWN, plan-dependent: whether the project's plan enforces a maximum
session length regardless of the settings above. The Free and Pro plans do
not; if the project is moved to a plan with a compliance profile, re-check
this section. The Pairing screen is the safety net either way.

## The Wi-Fi hand-off (I1.4) — probe before choosing

A web page cannot join a network. The button on every Wi-Fi/offline screen
is an `intent:` link that asks Android for its own picker (`lib/wifi.ts`):

```
intent:#Intent;action=android.settings.panel.action.WIFI;S.browser_fallback_url=<origin>/offline.html?wifi=unavailable;end
```

The Wi-Fi settings *panel* (Android 10+) is a sheet over the app that lists
networks, takes a password, and returns — the app never leaves the screen.
`android.settings.WIFI_SETTINGS` (the full Settings page) is exported from
the same file as a fallback for older Android. Chrome sends the tablet to
`browser_fallback_url` when no activity will take the intent, so a refused
hand-off shows a page that says "call Premium" rather than a dead button.

**Not yet probed.** This needs the trial tablet under the Hexnode kiosk
policy, which this repo cannot reach. The probe, in order:

1. **(a) The intent from the TWA.** Enrol the trial tablet, apply the kiosk
   policy with only `com.pfdworks.orders` allowed, forget the office Wi-Fi,
   reboot. Expected: `offline.html`. Tap **Choose Wi-Fi network**.
   - Panel opens, network joins, page leaves for `/dashboard` by itself →
     ship (a) as is.
   - Nothing happens, or the page reloads with the "can't open Wi-Fi
     settings from here" note → lock-task mode is blocking Settings. In
     Hexnode: Kiosk → Settings → *Allowed apps / Peripheral settings*, add
     **Settings** (`com.android.settings`), or enable the Wi-Fi peripheral
     toggle, and retry. If that unblocks it, record the policy line here.
2. **(b) Hexnode's own Wi-Fi button.** Hexnode's kiosk launcher can expose a
   Wi-Fi settings shortcut on the kiosk bar. If (a) cannot be made to work,
   the in-app button stays (it is right on every non-kiosk tablet) and the
   restaurant is told to use the kiosk bar's Wi-Fi icon. Document which
   Hexnode setting, and the exact icon label, here.
3. **(c) The escape hatch, always available:** collect the store's Wi-Fi
   name and password on the go-live call and push a Wi-Fi profile from
   Hexnode. The tablet joins on arrival and never shows the Wi-Fi screen at
   all. This is the path for zero-touch tablets anyway (Android's own
   first-boot Wi-Fi step runs before enrolment).

Decision recorded here once probed: **pending.** (a) is shipped and is
correct on any tablet where Settings is reachable; (c) is the documented
fallback for the go-live call.

## Pairing (I1.5) — a tablet with no session

The tablet never shows a username or password field again. With a network
and no session it lands on `/link` (middleware sends `/dashboard` and
`/order/*` there; `/admin` still goes to `/login`, which is staff-only):

```
tablet   POST /api/kiosk/link-code  { device }          → { code, expires_at, poll_every_ms }
tablet   GET  /api/kiosk/link-status?code=&device=      → { status: pending }   every 5 s
office   POST /api/crm/tablets/link { code, restaurant_id, actor }   (CRM_WRITE_KEY)
tablet   GET  /api/kiosk/link-status?code=&device=      → { status: linked, token_hash, restaurant }   once
tablet   supabase.auth.verifyOtp({ token_hash, type: "magiclink" })  → session cookies → /dashboard
```

- `device` is a random 32-character id the tablet mints once
  (`premium.device`). It is what the code is bound to: a code overheard in a
  kitchen cannot be redeemed on a different tablet. It is deliberately not a
  fingerprint of the hardware — every unit of the same model has the same
  fingerprint, and that is exactly the fleet this is for.
- Codes live 30 minutes, six digits, uniform. One address may create twenty
  in ten minutes. A device that still holds a pending code is handed the
  same one back, so a reload mid-phone-call does not change the number.
- The office half finds the restaurant's tablet login with the same rule
  provisioning uses (`ensureTabletLogin` in `lib/provision.ts` — never a
  second login, never a reset password) and calls
  `auth.admin.generateLink({ type: "magiclink" })`. Nothing is emailed; the
  `hashed_token` is stored on the code row, collected once by the owning
  device (`consumed_at`, claimed in the same statement that reads it), and
  verified in the browser. Nobody ever sees it. The login audit records
  `linked`.
- Wrong device, unknown code: 404, same as no such code. Expired: 410.
  Already linked: 409. Each is named so the person on the phone knows
  whether to say "read me a new one" or "it's done, wait a moment".

Table: `kiosk_link_codes` (migration 035). Service role only. Rows are
small and expire; a nightly delete of rows older than a day is a sensible
follow-up, not a requirement.

## Offline (I1.6)

Two places, one message:

- **Cold boot with no network:** `offline.html` (the same static page as the
  Wi-Fi screen) reads `premium.setupDone` and shows the red strip and the
  restaurant's name instead of the setup copy.
- **A running dashboard that loses its network:** `liveState()` goes
  `offline`; the dashboard shows the strip with "reconnecting since
  6:39 PM" (the clock is kept from the moment the stretch began), the
  **Choose Wi-Fi network** button, the existing orders dimmed so the kitchen
  can finish them, and the footer *"If this lasts, Premium is told
  automatically."* — worded that way because the office's alarm
  (`tablet_not_watching`) fires after fifteen silent minutes while orders
  arrive, not the instant the socket drops.

The offline page polls `/api/version` every 5 s and on the `online` event,
and leaves for `/dashboard` the moment the server answers. The dashboard's
own poll and realtime reconnect do the same for the running case.
