# The kiosk: device binding, first run, sessions, pairing, offline

Workstream I1 (`docs/briefs/2026-09-16-kiosk-first-run-and-orders.md`).
Nick's rule, 2026-09-16, after the Hexnode call: **the restaurant touches
nothing but the kiosk's Wi-Fi button** — which Hexnode draws, not this
app. No login, no pairing, no toggles at the store. A tablet boots straight
into its restaurant with no login screen.

## What a tablet shows before the order list

Three states, decided by `firstRunScreen()` in `lib/first-run.ts`:

| network | session | set up on this device | screen |
|---|---|---|---|
| no | – | – | **Offline** — `public/offline.html`, served by the service worker |
| yes | no | – | **Pairing** — `/link`: bootstrapping its device reference, and showing a link code |
| yes | yes | no | **Ready** — `components/ReadyScreen.tsx`, three checks, then the orders |
| yes | yes | yes | **Orders** |

There is **no Wi-Fi screen and no Wi-Fi control** anywhere in the app. A
web page cannot join a network, and the kiosk already has the button that
can; every screen that mentions the network says *"To change networks, use
the Wi-Fi button at the bottom of the screen."* (`KIOSK_WIFI_HINT`) and
nothing more. `scripts/test-first-run.ts` fails if any screen grows one.

"Set up on this device" is `localStorage["premium.setupDone"]`, written
the first time the Ready screen finishes. Keys live in `lib/kiosk-cache.ts`;
`offline.html` reads the restaurant's name by the same key because it
cannot import anything (it is the page for when nothing loads).

## Device binding (1b) — how a tablet knows whose it is

The app cannot read the hardware serial: Android 10+ keeps `Build.getSerial()`
from everything but the device-owner agent, and the app does not try. So
the Android shell hands the page a **device reference** on the start URL,
`/dashboard?shell=6&device=<ref>`, and the page asks the bridge whose
tablet that is. (Shell 5, the build on tablets today, sends the same
reference; 6 adds the device secret below.)

### The shell (`android/`, one rebuild → appVersionCode 5)

`LauncherActivity.getLaunchingUrl()` appends `?device=` from, in order:

1. **1b-i — managed app configuration.** `res/xml/app_restrictions.xml`
   declares one string key, `device_ref`, and the manifest points at it
   (`android.content.APP_RESTRICTIONS`). Hexnode's **App Configuration**
   for `com.pfdworks.orders` sets `device_ref` per device to the tablet's
   serial using the console's dynamic value for serial number.
   **UNKNOWN until verified on the trial tablet:** the exact wildcard.
   Hexnode's documented dynamic-value syntax is `%serialnumber%` (its
   configuration wildcards are `%devicename%`, `%serialnumber%`, `%imei%`,
   `%udid%`, `%email%`, `%username%`); if the App Configuration editor
   does not expand it, that is the "no serial wildcard" case and 1b-ii
   takes over with no rebuild.
2. **1b-ii — self registration.** When no managed configuration is
   present, `Settings.Secure.ANDROID_ID` (no permission, stable for the
   life of the install) is sent as `aid:<id>`. The bridge records it; the
   CRM's Tablets page lists it as **"New tablet seen 2 min ago · model ·
   Assign to…"**; assigning writes the binding to the bridge and the
   tablet's next bootstrap poll gets its session. One click at the office.

Both paths are in the same shell, so switching from 1b-i to 1b-ii is a
Hexnode setting, not another APK. The reference is remembered on the
tablet (`premium.deviceRef`) so a lost session mid-life still knows who it
is even before the shell relaunches.

### The bridge

- `kiosk_devices` (migration 036): `device_ref → restaurant_id`, plus what
  the tablet said about itself and when. **The CRM owns the assignment and
  pushes it here** — `POST /api/crm/tablets/bind` on assign/unassign (one
  entry) and after every MDM sync (the whole map). A boot never depends on
  the CRM answering; the bridge answers from its own table. The brief
  described the reverse (bridge pulls `GET /api/tablets/by-ref` from the
  CRM); push was chosen so the bridge needs no CRM URL or credential and a
  tablet can boot while the CRM is down.
- `POST /api/kiosk/bootstrap { device, secret?, model? }` (unauthenticated —
  the caller has no session yet; see "Device secret" below for `secret`):
  - `bound` → `{ token_hash, restaurant }`. A magic-link hash for the
    restaurant's tablet login, minted now by `lib/tablet-session.ts` (the
    same helper the link-code path uses: `ensureTabletLogin` — never a
    second login, never a reset password — then `generateLink`). The page
    verifies it in the browser; that sets the cookies.
  - `unbound` → recorded with `restaurant_id null`; the page keeps asking
    every 5 s and shows the link code meanwhile.
  - throttled → bound, but a session was minted <30 s ago. A reload loop
    or a replayed reference does not mint a session a second. Answered
    with the same body as `unbound` since SH1, so nobody can tell a live
    serial from an unknown one by asking twice.
  - Every call is logged (`kiosk_bootstrap_log`); 300 per address per 10
    minutes, generous because unbound tablets poll.
- `GET /api/crm/tablets/unbound` — what the CRM's "new tablets seen" list
  reads: references seen in the last 7 days with no restaurant.

### The page

`/link` runs both paths at once and whichever answers first wins,
exactly once (`settle()`): bootstrap every 5 s while a reference is known,
and the link code's own poll. Copy: *"Waiting for Premium to assign this
tablet — Premium can assign it from the office, or call (615) 619-5081 and
read them this code."* No input of any kind; no link to `/login`.

### Device secret (SH1 / Z-02) — the serial alone is not enough

The reference is printed on the tablet and shown in the CRM, and bootstrap
has to be unauthenticated. Until SH1, knowing a serial was enough to be
handed that restaurant's tablet session. Now a tablet also holds a **device
secret** (32 random bytes) and the bridge keeps only its sha256
(`kiosk_devices.secret_hash`, migration 067).

| the row | `KIOSK_REQUIRE_SECRET` unset (default) | `KIOSK_REQUIRE_SECRET=1` |
|---|---|---|
| has a `secret_hash` | a session only for the matching secret; anything else is `unbound` | same |
| has none | as before — the reference is enough | `unbound` |

Where the secret comes from:

- **`aid:` tablets** — when the tablet collects a link code
  (`/api/kiosk/link-status?…&ref=<its reference>`) and the office has
  already assigned that reference to the same restaurant, the one `linked`
  answer also carries `device_secret`. The page keeps it in
  `localStorage["premium.deviceSecret"]` and sends it in the **body** of
  every later bootstrap. Linked again → a new one replaces it.
- **Hexnode serials** — the CRM's Devices console generates it, sends the
  bridge only the hash (`POST /api/crm/devices/:ref/secret`), and shows the
  secret once. It goes into Hexnode's App Configuration under
  **`device_secret`**. Shell 6 reads it and appends it to the start URL as a
  **fragment** — `/dashboard?shell=6&device=<ref>#dsec=<secret>` — because
  a fragment is never sent to a server (so it is in no request log, unlike
  `?device=`). The page stores it and removes the fragment from the address.
  A Trusted Web Activity has no other channel from the shell to the page.

What a tablet without the right secret sees: the same Pairing screen as an
unassigned one — the link code, and "call Premium". Linking by code needs no
secret, so it is never a dead end. Moving an `aid:` tablet to another
restaurant ends its secret; a Hexnode serial keeps its own (rules and
reasons: `secretsEndedByBind` in `lib/device-binding.ts`).

**Before `KIOSK_REQUIRE_SECRET=1`:** every tablet on a wall needs a
`secret_hash`, or the next time it loses its session it lands on the link
code instead of signing itself back in. A tablet that is signed in keeps
working either way — bootstrap only runs when there is no session.

## What the Hexnode policy must set for `com.pfdworks.orders`

Recorded 2026-09-16 from the trial tablet (FACT unless marked). Three
things, and the CRM/bridge assume all three; a tablet enrolled without
any one of them shows a screen that says so.

| Hexnode console | Setting | Why |
|---|---|---|
| **Policies → Apps → Required Apps** (Android) | `com.pfdworks.orders` (the uploaded enterprise APK) — required, silent install and update | The restaurant downloads nothing. The shell reaches the tablet from here and nowhere else; new shells (appVersionCode bumps) are pushed the same way. |
| **Policies → Apps → App Configuration** (managed app config) | `device_ref` = `%serialnumber%` (Hexnode's dynamic value for the device serial) | 1b-i above: the shell reads `device_ref` from managed configuration and puts it on the start URL, and the bridge resolves it to a restaurant through the CRM's inventory. The CRM's own `tablets.serial` comes from the same Hexnode record, so the two match with nobody typing a serial. Editor payload: `docs/hexnode-app-config.json`. If the editor does not expand the wildcard, leave the key unset and 1b-ii (`aid:<ANDROID_ID>`) takes over with no rebuild. |
| **Policies → Apps → App Configuration** (same place; shell 6+) | `device_secret` = that tablet's own secret from the CRM Devices console | "Device secret" above. Optional until `KIOSK_REQUIRE_SECRET=1`. **UNKNOWN:** whether Hexnode's App Configuration can hold a different value per device (a custom attribute / per-device wildcard) or needs one policy per tablet — check in the console before generating secrets for the fleet. The checked-in payload carries a placeholder; a value that is not a secret's shape is ignored by the shell. |
| **Policies → Apps → App Permissions** → Premium → **Send push notifications: Allow** | Pre-grant `POST_NOTIFICATIONS` | The alert gate reads `Notification.permission === "granted"` on first run without a tap. With this missing, a kiosk shows **"Alerts are off on this tablet — call Premium on (615) 619-5081"** and reports `alert_state: "blocked"` on its heartbeat (migration 037) — the tablet has no Settings app to open, so the fix is here, in the console, and the gate re-checks by itself once a minute until it lands. |

Plus the kiosk profile itself (single-app kiosk on the package, screen on
while charging, auto-launch on boot, status bar and navigation blocked,
volume locked) — `docs/mdm-plan.md` §3 C7 lists it. None of those are read
by the app; the three above are.

## Sessions that outlive a year on a wall

The session has to survive a year of continuous use, power cuts, and
weeks offline. What keeps it alive and what would kill it:

- **The browser client refreshes it.** `@supabase/ssr`'s browser client
  has `autoRefreshToken` on; the dashboard tab is open all day, so the
  access token (1 h) is refreshed on schedule. The middleware refreshes it
  on every protected request too, so a tablet that slept through several
  expiries refreshes on its first page load back.
- **Refresh tokens do not expire on their own.** Supabase rotates them on
  use and keeps the family valid indefinitely unless one of two project
  settings is on. Both must stay **off**:
  - Authentication → Sessions → **Time-box user sessions**: *never* (the
    default). On, every tablet signs out on a schedule.
  - Authentication → Sessions → **Inactivity timeout**: *never* (the
    default). On, a tablet off for the holidays comes back to Pairing.
  - Authentication → Sessions → **Refresh token reuse interval**: leave at
    10 s. Two tabs refreshing at once (dashboard + ticket) need the window.
- **What still ends a session:** the login's password being reset (the
  CRM's "reset password" says so; nothing else resets one), the user being
  deleted, or Chrome's site data cleared by an MDM policy. All three land
  on Pairing, where bootstrap re-binds it in seconds — a recovery path,
  not a failure. (With a device secret, SH1: cleared site data also clears
  the stored secret. A Hexnode tablet gets it back from the shell the next
  time the app launches; an `aid:` tablet has to be linked by code once,
  which issues a new one.)

UNKNOWN, plan-dependent: whether the project's plan enforces a maximum
session length regardless of the settings above. Free and Pro do not.

## Pairing by code (1c) — the last resort

A tablet with a network, no session and no usable reference (or one the
office has not assigned yet) shows a six-digit code and "Call Premium":

```
tablet   POST /api/kiosk/link-code  { device }          → { code, expires_at, poll_every_ms }
tablet   GET  /api/kiosk/link-status?code=&device=      → { status: pending }   every 5 s
office   POST /api/crm/tablets/link { code, restaurant_id, actor }   (CRM_WRITE_KEY)
tablet   GET  /api/kiosk/link-status?code=&device=      → { status: linked, token_hash, restaurant }   once
tablet   supabase.auth.verifyOtp({ token_hash, type: "magiclink" })  → cookies → /dashboard
```

- `device` here is a random 32-character id the tablet mints once
  (`premium.device`) — what the code is bound to, so a code overheard in a
  kitchen cannot be redeemed on a different tablet. Deliberately not a
  hardware fingerprint: every unit of one model has the same fingerprint.
- Codes live 30 minutes, six digits, uniform. Twenty per address per ten
  minutes. A device that still holds a pending code is handed the same one
  back, so a reload mid-phone-call does not change the number.
- The office half finds the tablet login the same way bootstrap does
  (`lib/tablet-session.ts`), stores the hash on the code row, and the
  owning device collects it once (`consumed_at`, claimed in the same
  statement that reads it). Wrong device or unknown code: 404, same as no
  such code. Expired: 410. Already linked: 409. The login audit records
  `linked`.

Tables: `kiosk_link_codes` (035), `kiosk_devices` + `kiosk_bootstrap_log`
(036). All service-role only. A nightly delete of day-old code and log rows
is a sensible follow-up, not a requirement.

## Ready (first run)

Three checks read from real state: **Connected to Premium** (the
dashboard's own connection + a sync), **Order alerts on** (the alert
gate's hook, shared — if they are off, the one tap happens here as the
last step), **Kitchen printer online** (`GET /api/dashboard/status`, same
silence threshold the health checks alarm on; row omitted when there is
no printer). **Send me a test order** → `POST /api/dashboard/test-order`,
the same `lib/test-order.ts` the CRM button uses. Moves on 20 s after
everything is green, or on tap; never while alerts are off.

## Offline

- **Cold boot, no network:** the worker serves `offline.html` — red strip
  with "reconnecting since 6:39 PM", the restaurant's name from the cache,
  the kiosk-button line, and *"If this lasts, Premium is told
  automatically."* It polls `/api/version` and leaves for `/dashboard`
  the moment the server answers.
- **A running dashboard that loses its network:** `liveState()` goes
  `offline`; the same strip and line, the existing orders dimmed so the
  kitchen can finish them, and the same footer — worded that way because
  the office's alarm (`tablet_not_watching`) fires after fifteen silent
  minutes while orders arrive, not the instant the socket drops.

## Today, for the trial tablet at Willie Mae's (before the shell is rebuilt)

Manual, no code, from the brief: CRM → Devices → Willie Mae's → Logins →
**Show password** (or **Add a login**), sign in once on the tablet. The
session persists across reboots and kiosk relaunches. Record the serial
against Willie Mae's in Devices → Tablets so the binding above takes over
once appVersionCode 5 is on it.
