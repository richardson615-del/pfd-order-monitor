# PFD Order Monitor (MVP)

A installable PWA that watches a restaurant's inbox for PFD order emails,
parses them, and shows them on a live dashboard with push notifications and
a sound alert until each order is opened.

## How it works

```
Gmail inbox (restaurant)
      │  Gmail API (OAuth, read-only)
      ▼
Vercel Cron  ──▶  /api/gmail/poll  ──▶  parse HTML  ──▶  Supabase "orders" table
 (every 1 min)                                                 │
                                                                 ▼
                                                     Web Push notification
                                                                 │
                                                                 ▼
                                          Next.js PWA dashboard (installable,
                                          realtime via Supabase Realtime)
```

- **Frontend:** Next.js 14 (App Router), plain CSS, installable as a PWA - no
  App Store / Play Store needed. "Add to Home Screen" from the browser.
- **Backend:** Next.js API routes running on Vercel (including a scheduled
  Cron route that polls Gmail).
- **Database:** Supabase (Postgres + Auth + Realtime).
- **Email:** Gmail API via OAuth (read-only). IMAP fallback is stubbed in the
  schema (`monitored_inboxes.provider`, `imap_*` columns) but not built yet -
  see "What's not built yet" below.
- **Notifications:** Web Push (VAPID), no third-party push service needed.

## What's included

1. Restaurant login (Supabase magic-link email auth)
2. Admin panel to add restaurants + monitored inboxes, and connect Gmail
3. Gmail polling job that detects "Order 1159"-style subjects from a
   specific sender
4. HTML parser tuned to the sample ticket format (`Order_1159.eml`) that
   extracts order #, restaurant name, pickup/delivery, due time, customer
   name/phone/address, items + modifiers, item total, tax, service fee,
   customer total, and payment type
5. Dashboard with New / Opened / Completed / Printed tabs, realtime updates
6. Order detail page with the original HTML ticket in a sandboxed (script-free)
   iframe viewer, plus "Print" and "Mark complete" actions
7. Push notification + repeating sound alert (synthesized, no audio file
   needed) until an order is opened
8. Mobile/tablet friendly layout

## What's not built yet (by design - MVP first)

- **IMAP fallback.** Columns exist in `monitored_inboxes` for it, but only
  Gmail OAuth is wired up right now.
- **Direct ESC/POS Bluetooth printing.** "Print" currently opens the browser
  print dialog with the original ticket, which works with most
  Android/Chrome print services for thermal printers, but isn't a raw
  ESC/POS integration.
- **Multi-restaurant switching for one login.** A user can belong to more
  than one restaurant in the schema, but the dashboard currently just shows
  the first one.

---

## 1. Prerequisites

- A [Supabase](https://supabase.com) account (free tier is fine to start)
- A [Google Cloud](https://console.cloud.google.com) account (for Gmail API access)
- A [Vercel](https://vercel.com) account
- Node.js 18+ installed locally if you want to run this on your own machine
  before deploying (optional - you can also develop entirely through Vercel +
  a code editor)

---

## 2. Supabase setup

1. Create a new Supabase project.
2. Open **SQL Editor -> New query**, paste in the contents of
   [`db/schema.sql`](./db/schema.sql), and run it. This creates all tables,
   Row Level Security policies, and enables Realtime on the `orders` table.
3. Go to **Authentication -> Providers** and make sure **Email** is enabled.
   Under **Authentication -> URL Configuration**, set your **Site URL** to
   your Vercel domain once you have it (you can update this later).
4. Copy these three values from **Project Settings -> API** - you'll need
   them for your `.env`:
   - `Project URL` -> `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key -> `SUPABASE_SERVICE_ROLE_KEY` (keep this secret -
     it bypasses all security rules)
5. **Create your own admin account:**
   - Sign up once through the app's `/login` page (after you deploy, or via
     `supabase.auth.signInWithOtp` locally) using your own email.
   - Back in Supabase, go to **Table Editor -> admins** and insert a row with
     `auth_user_id` set to your new user's ID (find it under
     **Authentication -> Users**).
   - You now have access to `/admin`.

---

## 3. Gmail API setup

This lets PFD read (not send or delete) order emails from a restaurant's
inbox. Each restaurant grants access individually via Google's consent
screen - PFD never sees or stores their Gmail password.

1. Go to the [Google Cloud Console](https://console.cloud.google.com) and
   create a new project (e.g. "PFD Order Monitor").
2. **APIs & Services -> Library** - search for **Gmail API** and click
   **Enable**.
3. **APIs & Services -> OAuth consent screen**:
   - User type: **External**
   - Fill in app name ("PFD Order Monitor"), support email, and developer
     contact email.
   - Scopes: add `https://www.googleapis.com/auth/gmail.readonly`.
   - Test users (while in "Testing" mode): add every restaurant Gmail
     address you plan to connect, plus your own. You can move the app to
     "Production" later once Google reviews the read-only scope (optional
     for a small number of restaurants - test mode works fine and just
     requires you to add each inbox as a test user).
4. **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: add
     `https://your-app.vercel.app/api/auth/callback/google` (and
     `http://localhost:3000/api/auth/callback/google` if testing locally).
   - Save, then copy the **Client ID** and **Client Secret** into your
     `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
5. Set `GOOGLE_REDIRECT_URI` in your `.env` to the exact same URL you
   entered above.

**Connecting a restaurant's inbox** (once the app is deployed):
1. In `/admin`, add the restaurant with its monitored Gmail address.
2. Click **Connect Gmail** next to that restaurant.
3. Sign in with **that restaurant's Gmail account** (not your own) and
   approve the read-only permission.
4. You'll be redirected back to `/admin` showing "Connected".

---

## 4. Web Push (VAPID) setup

Web Push needs a public/private key pair (VAPID keys) - this is separate
from Google/Apple and doesn't require any account signup.

```bash
npm install
npm run gen:vapid
```

This prints a public and private key. Put them in your `.env` as
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.

> Note: iOS requires the PWA to be **installed to the home screen** (Safari
> "Add to Home Screen") before push notifications will work - this is an
> Apple restriction, not something this app can work around. On Android/
> Chrome, push works even from the browser tab.

---

## 5. Environment variables

Copy `.env.example` to `.env.local` for local development and fill in every
value from steps 2-4:

```bash
cp .env.example .env.local
```

For Vercel, add the same variables under **Project Settings -> Environment
Variables** (see deployment section below).

---

## 6. Local development

```bash
npm install
npm run dev
```

Visit `http://localhost:3000`. You can test the parser directly against the
sample email without any of the above setup:

```bash
# Already included: a small script that extracts the HTML body from a .eml
# and runs it through lib/parser.ts
npx tsx scripts/test-parser.ts /tmp/order_body.html
```

(If you want to test a different `.eml`, use any Python script or email
client to save its HTML part to a file and point the script at it - the
parser only needs the HTML body, not the full raw email.)

---

## 7. Deploying to Vercel

1. Push this project to a GitHub repo.
2. In Vercel, **Add New -> Project**, import the repo.
3. Add all environment variables from `.env.example` under **Settings ->
   Environment Variables** (Production + Preview).
4. Deploy.
5. Update `GOOGLE_REDIRECT_URI` (and the redirect URI in Google Cloud
   Console) to your real Vercel URL if it changed, then redeploy.
6. Update the Supabase **Site URL** (Authentication -> URL Configuration) to
   your Vercel URL.

### Cron (the Gmail polling job)

`vercel.json` already schedules `/api/gmail/poll` to run every minute:

```json
{
  "crons": [{ "path": "/api/gmail/poll", "schedule": "*/1 * * * *" }]
}
```

Two things to know:
- **Vercel Hobby (free) plan** only allows daily cron runs. For near-real-time
  order alerts you'll want a **Pro** plan, which allows per-minute cron.
  On Hobby, change the schedule to something like `0 * * * *` (hourly) or
  poll manually until you upgrade.
- Vercel automatically sends `Authorization: Bearer <value of CRON_SECRET>`
  when it calls a cron route, which is what `/api/gmail/poll` checks for -
  you don't need to configure anything extra beyond setting the
  `CRON_SECRET` environment variable.

If you'd rather not wait on Vercel Cron granularity, you can also call
`https://your-app.vercel.app/api/gmail/poll` from any external scheduler
(cron-job.org, GitHub Actions, etc.) with an `Authorization: Bearer
<CRON_SECRET>` header, as often as you like.

---

## 8. Onboarding a new restaurant (day-to-day workflow)

1. Go to `/admin` (you must be signed in as an admin).
2. **Add a restaurant** - enter its name, a slug, and the Gmail address that
   receives PFD order emails.
3. Click **Connect Gmail** and sign in as that restaurant's Gmail account to
   grant read access.
4. **Invite a restaurant login** - enter the owner/staff email you want them
   to use to log into the dashboard. They'll get a magic-link sign-in email.
5. On their tablet/phone, they open the app URL in Chrome (Android) or
   Safari (iOS) and choose **Add to Home Screen** / **Install app**. From
   then on it behaves like a normal app icon - no App Store needed.
6. Ask them to tap **Enable notifications** once on the dashboard.

---

## 9. Zuppler order ingestion (webhook + GraphQL)

Alongside the Gmail parser, orders can arrive from **Zuppler**. Zuppler sends a
thin webhook containing an `order_uuid`; our route fetches the full order from
their GraphQL API, maps it to the canonical shape, and ingests it through the
same path as email orders (de-dup, push, print dispatch).

**Route:** `POST /api/ingest/zuppler` (see
[`app/api/ingest/zuppler/route.ts`](./app/api/ingest/zuppler/route.ts))

### One-time setup

1. **Apply the migration.** Run
   [`db/migrations/002_multi_source_print.sql`](./db/migrations/002_multi_source_print.sql)
   in the Supabase SQL Editor. It is idempotent (`add column if not exists`) and
   safe to run once on the existing database. It makes `orders` source-agnostic
   (`source`, `external_id`, `raw_payload`, nullable `inbox_id`/`raw_html`),
   adds a partial unique index on `(source, external_id)` for cross-retry
   de-duplication, and creates the `print_devices` / `print_jobs` tables.

2. **Generate the webhook secret** yourself and set it in Vercel:

   ```bash
   openssl rand -hex 32
   ```

   Add it as `ZUPPLER_WEBHOOK_SECRET` (Production + Preview). This is the token
   Zuppler must send **verbatim** in the `Authorization` header. The route
   accepts either the raw token or a `Bearer <token>` form.

3. **Share the same secret and the webhook URL with Zuppler (Jerry).** Give
   them `https://your-app.vercel.app/api/ingest/zuppler` and the token above.

4. **Set `ZUPPLER_AMOUNTS`.** Zuppler's GraphQL money values are integer cents
   by default (e.g. `2700` = `$27.00`), so leave `ZUPPLER_AMOUNTS=cents`.
   **VERIFY against the first real order:** compare the dashboard totals to the
   Zuppler order. If they are off by 100x, set `ZUPPLER_AMOUNTS=dollars` and
   redeploy. (A wrong value makes every total off by 100x - this is the one
   setting to eyeball on the first live order.)

5. **Map the restaurant.** Set `zuppler_restaurant_id` (and optionally
   `zuppler_slug`) on the matching `restaurants` row, and ensure `is_active` is
   true. Until this exists, the webhook returns `{ ok: false, error: "unmapped
   restaurant" }` and the order is dropped (by design - it stops Zuppler's
   retries rather than 500ing forever).

   Zuppler restaurant IDs are 5-digit numbers (e.g. `29905`), and they are NOT
   guessable - get them from Zuppler, or let the first order tell you: the
   route logs `no restaurant mapped for zuppler_restaurant_id <id>`.

   **Replaying a dropped order.** Nothing was written to the database, so once
   the mapping exists you can re-send the order yourself - the webhook is just
   an `order_uuid`, and the full order is re-fetched from Zuppler:

   ```bash
   curl -X POST https://pfd-order-monitor.vercel.app/api/ingest/zuppler \
     -H "Content-Type: application/json" \
     -H "Authorization: $ZUPPLER_WEBHOOK_SECRET" \
     -d '{"order_uuid":"<uuid from the Vercel logs>"}'
   ```

   The uuid appears in the logs for every webhook call, so an order dropped
   for a missing mapping is recoverable rather than lost.

### Behavior / status codes

- **`401`** - missing or wrong `Authorization` token.
- **`422`** - no `order_uuid` in the body, or Zuppler has no such order.
- **`500`** - transient fetch/map failure; Zuppler **retries** (self-heals).
- **`200 { status: "duplicate" }`** - the order was already ingested. Safe under
  concurrent retries: even if two hit at once, the unique index rejects the
  second insert and it resolves to `duplicate`.
- **`200 { ok: false, error: "unmapped restaurant" }`** - config issue, retries
  stop; add the `zuppler_restaurant_id` mapping and the next order flows.

### Testing the mapper

The GraphQL -> canonical mapping is covered by assertion tests:

```bash
npm test    # runs scripts/test-zuppler-mapper.ts via tsx
```

They cover the delivery sample, pickup time-fallback, cents/dollars conversion,
discount notes, and malformed input. The tests are hermetic - they force
`ZUPPLER_AMOUNTS` internally, so your shell env does not affect the result.

---

## 10. Printing to a Bluetooth receipt printer

Every ingested order (email or Zuppler) queues one `print_jobs` row per active
`print_devices` row at that restaurant.

**For a LAN printer (e.g. NETUM NS8360), use [`print-agent/`](./print-agent/) -
it is built and ready.** A zero-dependency Node script that runs on any
always-on machine on the restaurant's network, pulls jobs, and prints over TCP
9100. No phone, no app, no Bluetooth. See
[print-agent/README.md](./print-agent/README.md).

An **Epson TM-m30III / TM-i** printer needs nothing on site at all - see
Server Direct Print below, which is the preferred setup.

A **Bluetooth** printer still needs a native Android app (see the constraint
table below); that app does not exist yet, but it would reuse the same API
contract described here.

### What the server already provides

Register a device (admin only) - the key is shown **once**:

```
POST /api/admin/print-devices   { "restaurant_id": "...", "name": "Front counter" }
  -> { device_key: "PFD-XXXX-XXXX-XXXX" }
```

The app then authenticates with `X-Device-Key` on both calls:

```
GET  /api/print/jobs    -> { jobs: [ { id, order_id, orders: { ...ticket data } } ] }
POST /api/print/jobs    { job_id, status: "printed" | "failed", error? }
```

- `GET` atomically **claims** what it returns, so double-polling can't print twice.
- Jobs stuck `claimed` for >2 min are re-offered (app crashed mid-print). Paired
  with the `(order_id, device_id)` unique constraint, this is at-least-once
  delivery without duplicate rows.
- `failed` re-queues up to 3 attempts, then stays `failed` for admin visibility.
- Optional `X-App-Version` / `X-Printer-Name` headers are stored on the device
  row, so `/admin` shows device health for free.
- A successful print flips the order to `status = 'printed'`.

### What the app has to do

1. Store the device key (entered once).
2. Poll `GET /api/print/jobs` every few seconds.
3. Render the returned order JSON into **ESC/POS** bytes.
4. Write those bytes to the paired Bluetooth printer.
5. `POST` back `printed` or `failed`.

### The Bluetooth constraint that drives the platform choice

Most thermal receipt printers (58mm/80mm ESC/POS, Epson TM, Star, and the cheap
generic ones) speak **Bluetooth Classic SPP**, not BLE. That has consequences:

| Approach | Works? |
|---|---|
| Android native app (Kotlin / React Native / Flutter) | **Yes** - full SPP access |
| Android PWA via Web Bluetooth | **No** - Web Bluetooth is BLE-only, cannot open SPP |
| iPhone / iPad | **No** for SPP - iOS blocks it without MFi certification |

So: **an Android app is the practical path**, and the dashboard PWA cannot do
the printing itself no matter how it is packaged. On iOS the only options are a
BLE-native printer or a WiFi/LAN printer.

### Alternatives that need no custom app

- **RawBT** (Android): a third-party ESC/POS print service driven by intents -
  a thin wrapper can hand it ticket bytes.
- **Epson "Server Direct Print"** (TM-m30 and similar, over WiFi/Ethernet): the
  *printer itself* polls a URL and prints the response. No phone, no app, no
  Bluetooth - just an endpoint returning ePOS-XML. Worth considering if the
  printer can sit on WiFi, since it removes the whole mobile app from the
  critical path.

### Server Direct Print (recommended for new sites)

**Built and in production.** The printer polls
`POST /api/print/epson` on a timer and prints whatever we return, so a site
needs **no agent, no PC, no Raspberry Pi and no app** - only the printer. This
is the deployment model to use for new locations.

Per-site install, start to finish:

1. **Register the device** in the app (admin) - keep the `PFD-XXXX-XXXX-XXXX`
   key it returns; it is shown once.
2. Plug the printer into the network and open `http://<printer-ip>/webconfig/`.
3. **Web Service Settings -> Direct Print**:

   | Field | Value |
   |---|---|
   | Server Direct Print | Enable |
   | ID | the device key |
   | Server 1 URL | `https://pfd-order-monitor.vercel.app/api/print/epson` |
   | Interval(s) | `5` |

4. Press **Access Test**. Done - orders now print.

Notes learned the hard way:

- Use **`PrintRequestInfo Version="1.00"`**. Version 2.00 adds `printjobid` but
  needs TM-i firmware 4.1+; the TM-m30III answers it with `code="SchemaError"`
  and prints nothing, surfacing as a failed print rather than a clear error.
- Because 1.00 carries no `printjobid`, results are matched to the oldest
  outstanding claim, so the endpoint hands out **one job per response**.
- The printer returns **HTTP 200 even when it refuses the job** - the real
  outcome is `success="true|false"` inside the body. Always parse the body.
- **Do not run the pull agent and Server Direct Print against the same
  device.** Both claim from the same queue and whichever polls first wins.
- The `ID` field is the only credential, sent over HTTPS. WebConfig also
  supports a Password for Digest auth if you want defence in depth.

### Design note: keep ticket layout on the server

`GET /api/print/jobs` currently returns structured order JSON and leaves
formatting to the app. Moving the layout server-side (returning preformatted
text or ESC/POS) means ticket changes ship instantly instead of requiring an
app update on every tablet. Worth deciding before the app is written.

---

## Database schema

See [`db/schema.sql`](./db/schema.sql) for the full schema with comments.
Summary of tables:

| Table | Purpose |
|---|---|
| `restaurants` | One row per restaurant/food truck client |
| `restaurant_users` | Links a Supabase Auth login to a restaurant |
| `admins` | PFD staff who can access `/admin` |
| `monitored_inboxes` | The inbox being watched per restaurant (Gmail tokens live here) |
| `orders` | Parsed order data + original HTML + status |
| `push_subscriptions` | Web Push registrations per device |

Row Level Security is enabled on every table so a restaurant can only ever
see its own orders, and only admins can manage restaurants/inboxes.

---

## Sample parser output

Running the parser against the attached `Order_1159.eml` sample produces:

```json
{
  "orderNumber": "1159",
  "ticketRestaurantName": "Swezey's Pub",
  "orderType": "pickup",
  "dueTime": "07/03/2026 12:20 PM",
  "customerName": "Eileen Gutierrez",
  "customerPhone": "(931) 302-3610",
  "customerAddress": "254 Village Square, Pleasant View, 37146",
  "items": [
    { "name": "Loaded FF", "price": "$6.50", "modifiers": ["Lemon pep. X 1"] }
  ],
  "itemsTotal": "$6.50",
  "tax": "$0.60",
  "serviceFee": "$0.59",
  "customerTotal": "$7.69",
  "paymentType": "CARD - Channel: zuppler"
}
```

The parser (`lib/parser.ts`) is intentionally written with a mix of
structural selectors (for the item table, which has a stable HTML
structure) and label-text matching (for totals and customer info, which are
more robust to minor formatting changes since it looks for the "Tax",
"Items", "C. Total" labels rather than a fixed cell position).

If PFD's ticket template changes, send an updated sample email and re-run
`scripts/test-parser.ts` against it - most future changes should only need
small tweaks to `lib/parser.ts`, not a rewrite.

---

## Project structure

```
app/
  api/
    auth/callback/google/route.ts   Gmail OAuth callback
    gmail/connect/route.ts          Kicks off Gmail OAuth (admin)
    gmail/poll/route.ts             Cron job: fetch + parse + store + notify
    orders/[id]/route.ts            PATCH order status
    push/subscribe/route.ts         Save a push subscription
    admin/restaurants/route.ts      Admin: create restaurant + inbox
    admin/restaurant-users/route.ts Admin: invite a restaurant login
  dashboard/page.tsx                Order list (server component)
  order/[id]/page.tsx               Order detail (server component)
  admin/page.tsx                    Admin panel (server component)
  login/page.tsx                    Magic-link login
components/                         Client components (dashboard, viewer, admin UI)
lib/
  parser.ts                         HTML order-email parser
  gmail.ts                          Gmail API helpers
  push.ts                           Web push sending
  supabase.ts                       Supabase client helpers
  authz.ts                          Admin / restaurant-membership checks
  sound.ts                          Synthesized alert beep
public/
  manifest.json, sw.js, icons/      PWA files
db/schema.sql                       Full Supabase schema + RLS policies
scripts/test-parser.ts              Manual parser test against a sample email
```

---

## Security notes for an MVP going into production

- Gmail refresh tokens are stored as plain text in `monitored_inboxes` for
  MVP simplicity. Before handling many restaurants' real inboxes long-term,
  consider encrypting these at rest (e.g. Supabase Vault) or restricting
  table access further.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security - it's only
  ever used in server-only code (`lib/supabase.ts` -> `supabaseAdmin()`,
  used by the cron/admin routes). Never send it to the browser.
- The order HTML viewer renders the ticket inside a `sandbox=""` iframe,
  which blocks scripts, forms, and popups from the email content itself.
