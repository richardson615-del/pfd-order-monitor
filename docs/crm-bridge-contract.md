# CRM bridge contract

Base: `https://pfd-order-monitor.vercel.app`
Auth: `Authorization: Bearer <CRM_WRITE_KEY>` on every route.
Errors: `{ "error": "..." }` with a real status. `503` means the bridge is
misconfigured (key unset, too short, or equal to the read key) — that is a
different problem from `401`, and they are deliberately not conflated.

## Devices

| method | path | body | returns |
|---|---|---|---|
| GET | `/api/crm/devices` | — | `{ devices: [...] }` |
| POST | `/api/crm/devices` | `{ restaurant_id, name, restaurant_name }` | `{ device, device_key, restaurant_created }` |
| POST | `/api/crm/devices/:id` | `{ action, ... }` | varies |

`device_key` is returned **once** and by no read path. Restaurants are
find-or-created, so `restaurant_name` is required — the CRM knows about
venues this database does not.

Device object: `id, name, model, transport, is_active, last_seen_at, online,
created_at, text_scale, effective_text_scale, restaurant {id, name}`.

`online` and `effective_text_scale` are computed server-side so the console
never re-implements the thresholds or the inheritance rule.

Actions: `activate`, `deactivate`, `rename {name}`, `reassign {restaurant_id,
restaurant_name?}`, `test_print`, `set_text_scale {text_scale}`.

`set_text_scale` takes `"normal"`, `"large"`, or `null` to inherit the
restaurant. `null` is a real value here, not an omission.

`test_print` returns `409` on an inactive device: the printer's poll is
rejected while inactive, so the ticket would queue forever and read as a
hardware fault.

## Restaurants

| method | path | body | returns |
|---|---|---|---|
| GET | `/api/crm/restaurants` | — | `{ default_footer_text, latest_shell_version, restaurants: [...] }` |
| GET | `/api/crm/restaurants/:id` | — | `{ latest_shell_version, restaurant }` — one row in exactly the roster's shape; 404 if unknown |
| POST | `/api/crm/restaurants` | `{ crm_restaurant_id, name, zuppler_restaurant_id?, zuppler_ids?, timezone?, app_expected?, display_mode? }` | `{ ok, restaurant_created, warning?, restaurant }` |
| POST | `/api/crm/restaurants/:id/provision` | `{ actor? }` | `{ ok, restaurant, login, printers, destinations, changed }` |
| POST | `/api/crm/restaurants/:id/relink` | `{ crm_restaurant_id, actor? }` | `{ ok, changed, previous_crm_restaurant_id, crm_restaurant_id, warning?, restaurant }` |
| POST | `/api/crm/restaurants/:id` | any subset below | `{ ok, conversions?, restaurant }` |
| POST | `/api/crm/restaurants/:id/ticket-preview` | any subset below | **`image/png`** |

`POST /api/crm/restaurants` links an account's Zuppler listings to its
restaurant here, find-or-creating the restaurant by `crm_restaurant_id` the
same way devices do. **Additive and idempotent**: ids not in the list are
left alone (a sync never unmaps), the same list twice changes nothing. The
**first id is the primary** and fills `restaurants.zuppler_restaurant_id`
only when that column is empty — accounting joins on it. Any id already
owned by a different restaurant refuses the whole request with `409` naming
that restaurant; a non-numeric id is `400`. The roster (`GET`) carries
`zuppler_ids: string[]`, primary first, so the console can show which of an
account's listings will route and which will be dropped on arrival.

`POST /api/crm/restaurants/:id/relink` (R1, 2026-09-24) moves this
restaurant's link to **another CRM account** — the bridge half of a CRM
account merge ("Move the bridge link to the survivor"). `:id` is either id;
`crm_restaurant_id` is the new CRM account uuid. It changes **only**
`restaurants.crm_restaurant_id`: the restaurant's own `id`, printers,
tablets, logins, orders, Zuppler ids and settings stay put, because all of
them hang off `restaurants.id`. No table stores a CRM account id per order,
so `GET /api/crm/accounting/orders?restaurant_id=<new id>` returns the
restaurant's orders from before the relink too; the old account id is a
`404` from the next call (nothing is cached by it). **Idempotent** — already
linked to that account → `200 { ok, changed: false }`, no audit row.
Errors carry a `code`: `crm_account_taken` (409 — another restaurant here
already answers to that id, as its CRM account or its own id; the message
names it; two restaurants are never merged), `invalid_crm_restaurant_id`
(400, not a uuid), `restaurant_not_found` (404). Every change writes a
`restaurant_link_audit` row (migration 043: actor, old and new account id,
time); if that write fails the relink stands and the response carries
`warning`. `restaurant` is the roster row shape.

`POST /api/crm/restaurants/:id/provision` is the bridge half of **"Go
live on tablet"** as one call: makes the restaurant active, sets
`app_expected`, creates a tablet login if none exists (username = slug of
the restaurant name, `-2`/`-3` on collision — nobody invents one), and
returns `login {username, password?, created}` (the password **only when
newly created**), `printers[]`, `destinations` and `changed[]` (what this
call actually did). **Idempotent** — a second call returns the same state
with `changed: []` — and it **never resets** an existing password: the one
on the wall is the one that works, and `?reveal=` shows it again.

`POST /api/crm/restaurants` (create-or-ensure) also accepts `name` (alias of
`restaurant_name`), a single `zuppler_restaurant_id` (the primary; folded
into `zuppler_ids`), and the settings `timezone`, `app_expected`,
`display_mode`, each validated like the update route. Errors carry a `code`:
`zuppler_id_conflict` (409, the id belongs to another restaurant — the
message names it), `invalid_zuppler_id`, `invalid_timezone`. Sending no
listings is a valid ensure.

Writable fields — send only what changes:

| field | values |
|---|---|
| `footer_text` | string; `""`/`null` clears to the global default |
| `footer_url` | must start `http://` or `https://`; QR target |
| `footer_mode` | `qr_with_text` \| `text_only` \| `image` |
| `design_style` | `classic` \| `bold` \| `editorial` |
| `text_scale` | `normal` \| `large` |
| `logo_image` | base64 or `data:` URL; `null` clears |
| `footer_image` | base64 or `data:` URL; `null` clears |
| `image_mode` | `auto` (default) \| `threshold` \| `dither` |

Images are converted **once, on write**, to 576px monochrome. The print path
does no image work. The response carries `conversions` describing what the
server did:

```json
{ "conversions": { "logo_image": {
    "width": 576, "height": 136, "mode": "threshold",
    "reason": "auto: line art detected, hard threshold",
    "stored_bytes": 2697 } } }
```

`auto` measures how much of the image sits in the middle of the tonal range:
line art is strongly bimodal and gets a hard threshold, continuous tone gets
dithered. Getting this backwards is very visible — dithered line art speckles,
thresholded photographs turn to mud — so the reason is reported rather than
left to be guessed at.

The roster returns `has_logo`, `logo_bytes`, `has_footer_image` rather than
the image data: a list view that shipped every logo would be megabytes.

### Ticket preview

`POST /api/crm/restaurants/:id/ticket-preview` returns a **PNG of a sample
ticket**, 576px wide, and writes nothing. Any writable field above may be
sent to preview a change before saving; anything omitted uses the saved
value. `order_type: "delivery"` previews the delivery layout.

It runs the same header and footer renderer the printer receives, and draws
the body to the printer's own metrics — 48 columns across 576 dots,
double-height meaning taller and never wider. A preview that people trust and
that quietly differs from the paper is worse than no preview.

`test_print` remains the physical confirmation after saving.

## Destinations (printer, tablet, or both)

An order reaches a restaurant on paper, on a screen, or both. These are two
destinations for one order, not two kinds of order.

Paper is an either/or — `print_method` picks an Epson or an email to a PC
running AEM, which are two ways of producing the same ticket. The tablet is
independent of that choice.

Writable on `POST /api/crm/restaurants/:id`:

| field | values |
|---|---|
| `app_expected` | `true` \| `false` — is this site meant to watch orders on the tablet? |
| `display_mode` | `kitchen` \| `standard` — which look their tablet renders |
| `timezone` | IANA zone (`America/New_York`) the tablet clock shows, or `null` for the device's own time. 400 for a name Intl cannot render. Presentation only (migration 032) |
| `prep_minutes` | whole minutes the tablet counts down from **Accept** (I3, 2026-09-17, migration 040). Integer 1–180; default 25; 400 `invalid_prep_minutes` otherwise. Never null |

`GET /api/crm/restaurants` adds:

| field | meaning |
|---|---|
| `app_expected` | as above |
| `timezone` | as above, `null` when never set |
| `prep_minutes` | as above; always a number (25 unless the CRM set it) |
| `zuppler_ids` | every Zuppler listing this restaurant routes, primary first |
| `tablet` | the tablet's state from its own heartbeat — see below |
| `has_active_printer` | whether an active print device exists — a fact, not an intention |
| `destinations` | `["printer"]`, `["app"]`, `["printer","app"]`, `["email","app"]`, or `[]` |

### The tablet object

Every field is nullable and **`null` means "no data", never a guess** — the
CRM must not infer one field from another, and must not compute `online`
itself.

```json
"tablet": {
  "expected": true,             // = app_expected: is this site meant to watch the tablet?
  "last_seen_at": "…|null",     // dashboard_heartbeats.last_seen_at; null = no screen has ever checked in
  "online": true,               // server-computed: last_seen_at within 5 min (TABLET_ONLINE_WITHIN_MS)
  "push_subscribed": true|null, // the last heartbeat's own report; null = it did not say (older client, no row)
  "alert_state": "hidden|ask|blocked|unsupported|null", // WHY it cannot ring, from the same heartbeat (037); null = it did not say
  "push_subscriptions": 2,      // live push_subscriptions rows for this restaurant
  "shell_version": 4|null,      // Android shell appVersionCode from the last heartbeat; null = it did not say
  "display_mode": "kitchen",    // as above
  "user_agent": "…|null",       // roughly which device; not identity
  "device_ref": "R8YL42BJPSB|aid:…|null", // the kiosk unit bound to this restaurant (kiosk_devices, I1): Hexnode serial or aid:<ANDROID_ID>; null = no binding pushed
  "device_seen_at": "…|null",   // when that unit last bootstrapped; null = never / no binding
  "device_model": "…|null",     // what it said it was on bootstrap; not identity
  "device_count": 1             // units bound here; 2 = a store that runs two (device_ref is the most recently seen)
}
```

The same object, built by the same code (`lib/crm-roster.ts`), is on the
roster, on `GET /api/crm/restaurants/:id`, and on every issue in the
issues feed that names a restaurant — so a ticket, a partner page and the
Devices console cannot disagree about one tablet.

The list response also carries a top-level **`latest_shell_version`**: the
oldest shell the office is happy with (`MIN_SHELL_VERSION` on the bridge), or
`null` when none is set. A `tablet.shell_version` below it is a tablet the
MDM still needs to update; the tablet itself shows an amber line and asks the
restaurant for nothing.

`alert_state` is the tablet's own alert gate: `hidden` = alerts on; `ask` =
waiting for the one first-run tap; `unsupported` = no Push API (a plain
browser, not the shell); **`blocked`** = the notification permission is
denied. On a Hexnode kiosk that permission is granted by policy (App
Permissions → Premium → Send push notifications: Allow), so `blocked` means
the policy is missing or was changed — the tablet shows "Alerts are off on
this tablet — call Premium", and the fix is in the Hexnode console, never at
the store. The CRM should label it **Alerts blocked (MDM policy)**, distinct
from "Alerts off" (`push_subscribed=false` with any other state).

Two liveness signals exist and mean different things: this heartbeat is
"the app is open and talking to us" (2-minute cadence, primary); an MDM's
last-seen is "the device is reachable". Both online but heartbeat quiet means
the app is not running.

**Read `destinations`, don't re-derive it.** It is the same function the ingest
path uses, so the console cannot disagree with where orders actually go.

The three configurations in use:

| Setup | `print_method` | active device | `app_expected` | `destinations` |
|---|---|---|---|---|
| Printer only | `printer` | yes | false | `["printer"]` |
| Printer + tablet | `printer` | yes | true | `["printer","app"]` |
| Tablet only | `printer` | no | true | `["app"]` |

Note the third row: a tablet-only site still reads `print_method: "printer"`,
because that column says *which* paper route, not *whether* there is one. What
makes it tablet-only is having no device.

`destinations: []` means orders will be recorded and nobody at the restaurant
will be told. A write that produces it returns a **`warning`**, not an error —
it is the normal state halfway through onboarding, before the printer is
registered — so surface the warning rather than treating it as a failure.

`app_expected` does **not** switch push on. Push already fires wherever a
subscription exists. What the flag declares is that this restaurant is *meant*
to be watching the tablet, which is what earns a `print_jobs` row per order and
brings the app health checks into play. Someone still has to tap **Enable
notifications** once on the device.

### Monitoring

`app_alert_failed` is **critical**: an order never reached the tablet, and
nobody watching it has been told the order exists. It is never softened by what
the printer did — these are independent channels, each alerted on its own
terms, and a site running both must not get a quieter alert than a tablet-only
one. `restaurant_no_app_device` is a warning: `app_expected` is on but no device
has notifications enabled, so nothing can alert.

### The issues feed (E2)

`GET /api/crm/issues[?since=<iso>]` → `{ checked_at, since, counts, issues[], resolved[] }`.

Each issue: `key` (deterministic — the same problem always has the same
key, so the CRM can open one ticket per key and never two), `severity`,
`title`, `detail`, `restaurant_id` / `crm_restaurant_id` / `device_id`
(null for a fleet-wide issue such as a webhook or a cron), `first_seen_at`
and `notified_at` (from the five-minute monitor's `monitor_alerts` record —
**null until that run has stamped a brand-new issue**, so treat null as
"just now"). `resolved[]` lists keys the monitor closed in the last 24 h
(or since `since`) with `resolved_at`; resolution is observed by the
monitor run, never by this call, so two polls cannot disagree. `since`
narrows both lists to what changed after it; unstamped issues are always
included.

Since 2026-09-16 every issue that names a restaurant also carries that
restaurant's **`timezone`** (so a ticket can say "arrived 6:12 PM their
time") and its **`tablet`** object — the one documented above, identical
to the roster's — so the ticket can show last heartbeat, shell version,
`alert_state` and which unit (`device_ref`) without a second call. Both
are `null` on a fleet-wide issue (webhook, cron), never on a restaurant
one.
Ticket issues — `job_stuck:<job id>` (queued, claimed **or held** past ten
minutes) and `job_failed:<job id>` — carry an **`order`** object since
2026-09-16: `{ order_number, received_at, age_minutes, customer_name,
total, queued_by }` (`queued_by` = `ingest | test | login_print |
reprint:<actor>`, null for rows older than bridge migration 038). Every
other issue carries `order: null`. Their titles lead with the printer's
reason in plain English — **"Printer is out of paper: order 1196"**,
"Printer cover is open", "Printer offline" — never an ePOS code; the code
stays in parentheses at the end of `detail` for whoever reads the log.

What the bridge no longer does, so the CRM never sees it: an order older
than **`PRINT_MAX_AGE_HOURS`** (default 4) is *expired* at the moment it
would have gone to paper — never printed, never `job_stuck`, never
`job_failed` — unless Print was pressed for it in the last ten minutes,
and then it prints once with no retry loop. Out of paper / cover open
*holds* the job for the printer's next polls (up to an hour) instead of
burning three attempts in fifteen seconds; a held job surfaces as
`job_stuck` with the reason after ten minutes and as `job_failed` ("…for
over an hour") after sixty.

`order_unaccepted:<order id>` is **critical** and per order (2026-09-15): a
customer order on a tablet restaurant that nobody has **opened** three
minutes after it arrived. Never for a test order (no customer is waiting),
never past the six-hour chime window. The key keeps its name; since
2026-09-16 there is no Accept button on the tablet — opening the ticket is
the acknowledgement and stamps `accepted_at`, which is what clears this.
The monitor runs every minute.

### Restaurant logins

```
GET    /api/crm/restaurants/:id/logins
POST   /api/crm/restaurants/:id/logins    { username, actor? }
PATCH  /api/crm/restaurants/:id/logins    { username, actor? }
```

Who can sign in to a restaurant's tablet, and the two writes that change it.
Without these, onboarding a restaurant was four things in the CRM and a jump
to a different system for the fifth.

Restaurants sign in with a **username and password**, not an emailed link: a
kitchen tablet is shared, runs locked to one app, and has no inbox anybody is
watching. Supabase needs an email, so one is derived from the username and
receives nothing.

Both writes return the password. Since **migration 026** it is also stored, and
can be shown again: `GET /api/crm/restaurants/:id/logins?reveal=<username>`,
with the actor in an `x-crm-actor` header because a GET has no body, audited as
`password_shown`. That reversed the original write-once design deliberately —
no reset email can reach a derived address, so a password nobody can look up
means a reset every time a tablet is replaced, which is a phone call during
service. A login created *before* 026 has only Supabase's hash: `has_password`
is false for those and reveal answers `409`.

(This paragraph used to end "Nothing retrieves it afterwards", which stopped
being true the day 026 landed.)

| field | meaning |
|---|---|
| `username` | lowercase, 2-31 chars, letters/digits/`.`/`-`/`_`. Normalised, so case and stray spaces cannot make a second account |
| `actor` | who asked. The bridge authenticates with one shared key and cannot know; an absent actor is recorded as null, never guessed |
| `is_email_login` | on GET: true for an older account with a real address rather than a username |

**Every write is audited** (migration 023), the same judgement migration 015
made about printer device keys. The audit never stores the password - it
records that a change happened and who made it, not the credential.

A `PATCH` only touches a login belonging to **that** restaurant. `409` on a
username already taken. A reset says plainly that a tablet already signed in
stays signed in until its session ends - resetting does not rescue a tablet
that is currently stuck.

### Print a login on the restaurant's own printer

```
POST /api/crm/restaurants/:id/logins/print
  { username, mode: "existing" | "reset", device_id?, actor, include_setup_steps? }
```

Queues a ticket on that restaurant's Epson carrying the app address, the
username, the password and the four setup steps.

The gap this closes is a **channel**, not a feature. The CRM could already
create a login, reset one and show the password on screen — and then somebody
had to get it to the restaurant, in practice by reading it down the phone to a
kitchen during service. This puts it on the printer already standing in that
kitchen, so the person who has to type it is the person holding it.

`mode: "existing"` prints the stored password and changes nothing.
`mode: "reset"` rotates it first and the ticket says on its face that it is a
new one. `include_setup_steps` defaults to true.

**No order row is written.** `test_print` creates one deliberately; a
credential must not. An `orders` row shows on the restaurant's own screens, is
counted by the health checks, and is kept out of accounting by exactly one
`.neq("source","test")` filter — one forgotten filter away from a password in a
statement. Instead, migration **029** lets a `print_jobs` row carry a
`document`: ticket lines composed by the bridge, rendered by the same renderer,
with no order behind them. The ticket therefore carries **none** of the
restaurant's branding — no logo header, no "scan to order again" QR under the
password.

The device is chosen **before** the password is touched. Rotating and then
finding nowhere to print would leave a restaurant locked out with the only copy
of the new password on a screen in another state.

| status | `code` | meaning |
|---|---|---|
| `200` | — | `{ job_id, device {id,name}, username, mode, printed_at, device_last_seen_at, other_active_printers? }` |
| `404` | `login_not_found` | that username is not a login for this restaurant |
| `409` | `password_unavailable` | created before 026, so there is nothing to print. `resettable: true` — offer `mode: "reset"` |
| `409` | `no_active_printer` | this restaurant has no active printer |
| `400` | `device_not_for_restaurant` | the `device_id` given belongs elsewhere, or does not exist |
| `400` | `device_inactive` | that printer's poll is rejected while inactive, so the job would queue forever |
| `409` | `printer_not_supported` | that device prints through the on-site agent, which renders orders only |

An **offline** printer is not refused. The job queues and prints on the next
poll, which is the normal case: the usual reason to print a login is that
somebody is at the restaurant plugging the thing in. `device_last_seen_at` is
returned so the CRM can say so rather than implying it has already printed.

With no `device_id`, the bridge picks the restaurant's active printer, most
recently seen first, and returns `other_active_printers` when there was more
than one — so a console can offer the choice rather than trusting the guess.

Every print is audited as `password_printed`, and a `reset` audits
`password_reset` as well.

### Test order to the tablet

```
POST /api/crm/restaurants/:id/test-order
```

Sends a test order to the restaurant's TABLET: the screen lights up, chimes,
and the order can be opened and marked Done like any other. The only way to know
a newly installed tablet works before a customer finds out it does not.

**Sends to BOTH destinations** since 2026-09-14 (Nick): the tablet chimes and
the restaurant's printer gets the ticket.

It used to print nothing, so a tablet test could not put a fake order on the
spike in a working kitchen. What that missed is when the button is actually
pressed - during setup, in front of the equipment, wanting to know both halves
work. A restaurant receives orders on paper and on a screen; a test that proves
only one of them leaves the other to be discovered the first time it matters.

Safe to point at a live restaurant: the order is `source: 'test'` and says it
is not real in three places - a `TEST-` order number, the item name, and the
note.

`printers_queued` and `printers` report the paper half; `print_note` says why
paper did NOT go out when it did not, so an email restaurant cannot look
identical to a broken printer.

| status | meaning |
|---|---|
| `200 { ok: true, devices_reached }` | The tablet should be chiming |
| `409` | **Nowhere at all to receive** — no notifications enabled *and* no active printer. Checked before an order is written. It is no longer "no subscription": that would block the printer half at every site whose tablet is not set up yet, which is the set of sites being set up |
| `502` | The order was created and reached **nothing** — no device took the push *and* no printer took the job. A successful print is not reported as a failure because the tablet did not answer |

It works **before** `app_expected` is turned on, and returns a `warning` saying
so. That order matters: prove the tablet chimes first, then turn
`app_expected` on. Reversed, every order raises a critical `app_alert_failed`
until somebody enables notifications.

The tablet's own first-run Ready screen has a **Send me a test order**
button that sends the identical order (`lib/test-order.ts`, via the tablet's
session at `POST /api/dashboard/test-order`). Two buttons, one order.

### Link a tablet that has no session (I1.5)

```
POST /api/crm/tablets/link
{ "code": "123456", "restaurant_id": "<uuid>", "actor": "nick@pfdworks.com" }
```

A tablet with a network and no valid session — never bound, or its session
was lost — shows a six-digit code and "Call Premium". Nobody types a
credential on a tablet, ever (Nick, 2026-09-16). The office enters the code
here against the restaurant, and the bridge mints a session for that exact
device: the restaurant's tablet login (found or created by the same rule
provisioning uses — never a second login, never a reset password) gets a
server-side magic link whose hash the tablet collects once and verifies in
the browser. The office never sees the token; the tablet picks it up within
five seconds and shows the restaurant's orders.

`restaurant_id` is the bridge restaurant id (== CRM `accounts.id`).

Refusals carry `code` and a human `error`, the same shape as the login-print
endpoint, so the CRM can show the sentence to the person on the phone:

| status | `code` | meaning |
|---|---|---|
| `200 { ok, restaurant: {id, name}, login: {username, created}, note }` | | Linked. `created: true` means this call made the login |
| `400` | | Code not six digits, or no `restaurant_id` |
| `404` | `code_not_found` | No tablet is showing that code — ask them to read it again |
| `404` | `restaurant_not_found` | |
| `409` | `code_already_linked` | Somebody linked it already; the tablet should be showing orders |
| `410` | `code_expired` | Codes live 30 minutes. The tablet shows a new one — ask for it |
| `502` | | Auth did not return a usable link. Nothing was changed |

The CRM side: **Devices → Tablets → Link tablet**, code + restaurant. Full
flow and the two public kiosk routes the tablet uses: `docs/kiosk.md`.

### Bind tablets to restaurants (I1, 1b)

```
POST /api/crm/tablets/bind
{ "device_ref": "R52X30ABCDE", "restaurant_id": "<uuid>|null", "model": "Galaxy Tab A9", "actor": "…" }
{ "bindings": [ { "device_ref": …, "restaurant_id": … }, … ], "actor": "…" }
```

`restaurant_id` may be the CRM's account id or the bridge's own uuid — the
bridge resolves either (Standing rules). Until 2026-09-17 only the bridge's
uuid was accepted, so every push from the CRM's inventory (which holds
`accounts.id`) came back in `unknown_restaurants` and no tablet could bind.

**The CRM owns tablet assignment and pushes it here.** A tablet boots with a
device reference on its start URL — the serial Hexnode set through managed
app configuration, or `aid:<ANDROID_ID>` when there is none — and asks the
bridge whose it is; the bridge answers from this map and mints a session
for that restaurant's tablet login. Send one entry on assign and unassign
(`restaurant_id: null` unbinds), and the whole current map after every
MDM sync; the bridge upserts either way. `restaurant_id` is the bridge
restaurant id (== CRM `accounts.id`). Up to 2000 per call.

| status | meaning |
|---|---|
| `200 { ok, bound, unbound, unknown_restaurants: [] }` | Landed. A `restaurant_id` the bridge does not know is skipped and named |
| `400` | No usable bindings — every entry needs a reference matching `[A-Za-z0-9:._-]{4,128}` |

```
GET /api/crm/tablets/unbound
→ { devices: [ { device_ref, kind: "managed"|"android_id", model, user_agent, first_seen_at, last_seen_at } ] }
```

Tablets that have bootstrapped in the last 7 days and are assigned to
nobody: the **"New tablet seen 2 min ago · model · Assign to…"** rows on the
Tablets page. `kind` says where the reference came from; `model` is what
the tablet said about itself, never identity. Assigning one = bind.


## Orders (M1, 2026-09-18) — today's tickets for the office

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/api/crm/orders` | `?date=YYYY-MM-DD[&tz=America/Chicago][&restaurant_id=<either id>][&include_test=1][&since=<ISO>]` | `{ date, tz, generated_at, since, truncated, counts, orders[], deleted[] }` |
| POST | `/api/crm/orders` | a phone order (O1, below) | `201 { ok, created: true, id, order }`; `200` on an identical retry; 409 `external_id_conflict` / `order_number_conflict`; 422 `restaurant_not_found` |
| GET | `/api/crm/orders/:id` | — | `{ generated_at, order }` — the whole ticket; 404 `order_not_found` |
| POST | `/api/crm/orders/:id/actions` | `{ action: "reprint" \| "resend_app", actor }` | `{ ok, action, … }`; 409 `order_settled` / `app_not_expected`; 400 `invalid_action` |
| GET | `/api/crm/accounting/orders` | `?from&to[&restaurant_id=<either id>][&limit][&offset]` | money rows for statements — see below |

**Who this is for:** PFD staff in a browser. So `source` is shown (`zuppler`
| `email` | `test` | `phone` since O1), the
customer's full phone is in the detail (staff need to call), and nothing is
softened. **What is never returned:** `raw_html` / `raw_payload` — the email
parser's source can carry card-holder data.

**The day.** `date` is the calendar day in `tz` (default `America/Chicago`);
the window is exact for the two days a year that are not 24 hours. A bad
date or zone is 400 `invalid_date`. `restaurant_id` is **either id** (CRM
account id or the bridge's uuid — Standing rules); an id neither column knows
is 404 `restaurant_not_found`, not an empty day. Test orders are hidden unless
`include_test=1`. **`since`** returns only rows whose `updated_at` is after it
(migration 039) — poll it every 20 s for almost nothing; `counts` are always
the whole day's and `deleted` is always `[]` (a cancellation is a status).
Sorted **as the tablet sorts**: unaccepted oldest first, then in the kitchen
by least time left on the countdown, then completed/cancelled newest first.
Limit 2000 rows (`truncated: true` beyond).

**Each list row** (from the shaping code, `lib/crm-orders.ts`):

```json
{
  "date": "2026-09-18",
  "tz": "America/Chicago",
  "generated_at": "2026-09-18T23:30:00.000Z",
  "since": null,
  "truncated": false,
  "counts": {
    "total": 2,
    "unaccepted": 1,
    "in_kitchen": 1,
    "completed": 0,
    "cancelled": 0,
    "unprinted": 1,
    "test": 0
  },
  "orders": [
    {
      "order_id": "a1",
      "order_number": "1184",
      "source": "zuppler",
      "status": "new",
      "restaurant": {
        "id": "940bf644-0000-4000-8000-000000000001",
        "crm_restaurant_id": "45bef1a1-0000-4000-8000-000000000002",
        "name": "Willie Mae's Kitchen"
      },
      "received_at": "2026-09-18T23:26:00.000Z",
      "opened_at": null,
      "accepted_at": null,
      "completed_at": null,
      "cancelled_at": null,
      "printed_at": null,
      "updated_at": "2026-09-18T23:26:00.000Z",
      "due_time": null,
      "order_type": "pickup",
      "payment_type": "card",
      "channel_id": "web",
      "customer": {
        "name": "Marcus Bell",
        "phone_last4": "0142"
      },
      "items_line": "Shrimp Po'Boy · Gumbo (cup) · Lemonade …",
      "item_count": 4,
      "total": 31.92,
      "prep_minutes": 25,
      "destinations": [
        "printer",
        "app"
      ],
      "print": {
        "state": "none",
        "job_id": null,
        "failed_reason": null
      },
      "flags": {
        "unaccepted_over_3m": true,
        "late": false,
        "overtime": false
      }
    }
  ],
  "deleted": []
}
```

- `customer.phone_last4` — the list never carries the full number.
- `items_line` — the first three items, as the tablet card shows them; `item_count` the total.
- `prep_minutes` — the restaurant's target; `accepted_at + prep_minutes` is the countdown the tablet shows.
- `destinations` — `orderDestinations()`, same as the roster.
- `print.state` — `printed` \| `queued` \| `held` (printer waiting for paper/cover) \| `stuck` (pending past ten minutes) \| `failed` \| `expired` (too old to print, never printed) \| `none`; `failed_reason` is the printer's sentence (E2). Paper jobs only — the tablet push is `app_delivery` on the detail.
- `flags` — computed with the tablet's own helpers: `unaccepted_over_3m` (health's `order_unaccepted` line), `late` (ten minutes, `isLate`), `overtime` (countdown past zero).

**The detail** adds the full customer, the items with modifiers and prices
as printed, `notes`, `money` (dollars; `variance` ≠ 0 means the components
do not explain the total), `external_id` / `zuppler_order_uuid`, the
`timeline` (received → print attempts → opened → accepted → completed /
cancelled, each print attempt named by device and outcome), `print_jobs`
(paper only) and `app_delivery` (`null` when no push row exists):

```json
{
  "generated_at": "2026-09-18T23:30:00.000Z",
  "order": {
    "order_id": "a2",
    "order_number": "1183",
    "source": "zuppler",
    "status": "opened",
    "restaurant": {
      "id": "940bf644-0000-4000-8000-000000000001",
      "crm_restaurant_id": "45bef1a1-0000-4000-8000-000000000002",
      "name": "Willie Mae's Kitchen"
    },
    "received_at": "2026-09-18T23:26:00.000Z",
    "opened_at": "2026-09-18T23:26:30.000Z",
    "accepted_at": "2026-09-18T23:27:00.000Z",
    "completed_at": null,
    "cancelled_at": null,
    "printed_at": "2026-09-18T23:26:12.000Z",
    "updated_at": "2026-09-18T23:26:00.000Z",
    "due_time": null,
    "order_type": "pickup",
    "payment_type": "card",
    "channel_id": "web",
    "customer": {
      "name": "Marcus Bell",
      "phone": "(615) 555-0142",
      "address": null
    },
    "items_line": "Shrimp Po'Boy · Gumbo (cup) · Lemonade …",
    "item_count": 4,
    "total": 31.92,
    "prep_minutes": 25,
    "destinations": [
      "printer",
      "app"
    ],
    "print": {
      "state": "printed",
      "job_id": "5c1d…",
      "failed_reason": null
    },
    "flags": {
      "unaccepted_over_3m": false,
      "late": false,
      "overtime": false
    },
    "external_id": "zup-7f3a…",
    "zuppler_order_uuid": "zup-7f3a…",
    "ticket_restaurant_name": null,
    "items": [
      {
        "name": "Shrimp Po'Boy",
        "price": "$14.00",
        "modifiers": [
          "Dressed"
        ]
      },
      {
        "name": "Gumbo (cup)",
        "price": "$6.00",
        "modifiers": []
      },
      {
        "name": "Lemonade",
        "price": "$3.00",
        "modifiers": []
      },
      {
        "name": "Beignets",
        "price": "$5.00",
        "modifiers": []
      }
    ],
    "notes": "Extra napkins",
    "money": {
      "subtotal": 28,
      "tax": 2.59,
      "service_fee": null,
      "delivery_fee": null,
      "tip": 1.33,
      "discount": null,
      "surcharge": null,
      "included_tax": null,
      "hidden_fee": null,
      "total": 31.92,
      "variance": 0
    },
    "timeline": [
      {
        "at": "2026-09-18T23:26:00.000Z",
        "event": "received",
        "detail": null
      },
      {
        "at": "2026-09-18T23:26:12.000Z",
        "event": "printed",
        "detail": "printed on Kitchen"
      },
      {
        "at": "2026-09-18T23:26:30.000Z",
        "event": "opened",
        "detail": null
      },
      {
        "at": "2026-09-18T23:27:00.000Z",
        "event": "accepted",
        "detail": null
      }
    ],
    "print_jobs": [
      {
        "id": "5c1d…",
        "status": "printed",
        "device_id": "dev-1",
        "device_name": "Kitchen",
        "queued_at": "2026-09-18T23:26:00.000Z",
        "claimed_at": "2026-09-18T23:26:06.000Z",
        "finished_at": "2026-09-18T23:26:12.000Z",
        "attempts": 0,
        "error": null,
        "queued_by": "ingest"
      }
    ],
    "app_delivery": {
      "pushed": true,
      "at": "2026-09-18T23:26:03.000Z",
      "devices_reached": 1,
      "error": null
    }
  }
}
```

**`zuppler`** (M1b, 2026-09-18) — on the detail only, `null` for an email
or test order: `{ order_uuid, restaurant_id, admin_url }`. `order_uuid` is
Zuppler's uuid (our `external_id`), `restaurant_id` Zuppler's numeric
restaurant id. **`admin_url`** is the way back to the order in Zuppler's
customer-service area:
`https://customer-service.zuppler.com/#/lists/<list id>/order/<order uuid>`
(FACT, Nick 2026-09-18, from a real link; the list id is one saved list
shared by every restaurant, the order uuid is `external_id`). The bridge
fills it from `ZUPPLER_CS_LIST_ID`; `ZUPPLER_ORDER_URL_TEMPLATE` overrides
the whole shape if Zuppler ever moves (placeholders `{list_id}`
`{order_uuid}` `{order_number}` `{restaurant_id}`, values URL-encoded).
**`null` when the list id is unset or a placeholder's value is missing** —
the CRM shows the "Edit in Zuppler" button only when it is a string.
Zuppler's own payload carries no such link (the LoadOrder GraphQL
selection set has no URL field); the shape came from a pasted link, never a
guess.

**Actions** exist only because both primitives already did: `reprint` is
`queueOrderToPrinters()` — the tablet's own Print button — recorded as
`queued_by: reprint:crm:<actor>` (an order older than `PRINT_MAX_AGE_HOURS`
prints this once because somebody asked); `resend_app` is the same push a
new order gets, with the outcome written to the order's one app job row so
"was the tablet told?" stays one answer. `actor` is the CRM session's email —
the bridge cannot know it otherwise. Refused with 409 on a completed or
cancelled order, and `resend_app` with 409 `app_not_expected` when the
restaurant is not on the tablet. Neither edits or cancels an order; there is
no such endpoint.

**`GET /api/crm/accounting/orders`** (existed since 2026-09-01, undocumented
until now): per-order money rows for a `from`–`to` date range (UTC days,
`to` inclusive), excluding `source=test`, with `totals` (billable only),
a `cancelled` section (counted separately, `after_print_count` for tickets
that were already out) and `reconciliation` (`unreconciled_order_ids` where
`money_variance ≠ 0`). No items, customer, notes or timestamps beyond
received/printed/cancelled — use `/api/crm/orders` for those. Since
2026-09-18 its `restaurant_id` goes through the same either-id resolver (it
used to match the bridge uuid only, so a CRM account id silently returned
zero rows).

`limit` (default 1000, max 2000) caps a single response; `offset`
(default 0, added 2026-09-19) pages through a range larger than that.
`truncated: true` means exactly "this page is full, there may be more" —
the caller must request `offset + limit` next, not treat one response as
complete. `offset`/`limit` are echoed back on every response. Ordering is
`received_at, id` — the `id` tiebreaker is required for correct paging,
since `received_at` alone is not unique and two orders sharing a
timestamp would otherwise land on either side of a page boundary
nondeterministically between requests. A week carrying partner + chain +
backfill volume together crossed 1000 orders for the first time on
2026-09-18, and the CRM's own client was silently trusting a truncated
single request until this was added — see `fetchAccountingOrders` in
prs-crm, which now loops on `truncated`.

**Same-day correction (2026-09-19):** the first version of `truncated`
was computed as `rows.length === limit`. That's wrong whenever the
platform itself silently caps a single `.range()` read below the
requested `limit` — confirmed live: a request for up to 2000 rows
returned exactly 1000 with no error, so `rows.length` (1000) never
equalled `limit` (2000) and `truncated` came back `false` on a response
that was missing 149 real orders (the true total for that date range was
1149). The route now pages internally in 500-row chunks (a value
comfortably under the platform's own undocumented cap, not the exact
boundary) and computes `truncated` from whether a `(limit + 1)`-th row
was actually fetched — completely decoupled from whatever that
platform-level cap is. No change to the request contract (`limit`/
`offset`/`truncated` mean exactly what they did before); only the
correctness of `truncated` itself changed. A consumer that already loops
on `truncated` (prs-crm's `fetchAccountingOrders`) needs no changes to
benefit from this fix.

### Phone orders (O1, 2026-09-19) — an order the CRM took on the phone

```
POST /api/crm/orders
```

A dispatcher answers the phone, builds the order in the CRM (Workstream O),
charges the card **there**, and posts the result here. The bridge stores it
with `source: 'phone'` (migration 042) through the same `ingestOrder()` every
Zuppler order goes through, so the paper, the tablet and the AEM email are
decided by `orderDestinations()` exactly as for any other order, the print
queue and the push behave identically, and `orders.status` means what it
always meant. The order then shows in `GET /api/crm/orders` with
`source: "phone"`. The bridge takes no payment and holds no card data.

**Body** (`lib/phone-order.ts` `parsePhoneOrder()`; every rejection is a
400 whose `code` names the field):

```json
{
  "restaurant_id": "45bef1a1-…",
  "source": "phone",
  "external_id": "7d1f2c3a-9b8e-4c6d-a5f4-3e2d1c0b9a87",
  "order_number": "PH-1201",
  "order_type": "delivery",
  "due_time": null,
  "customer": { "name": "Marcus Bell", "phone": "(615) 555-0142", "address": "5432 Highway 76 East, Springfield, TN 37172", "address2": "Apt 4", "notes": "Gate code 4482" },
  "items": [
    { "name": "Shrimp Po'Boy", "price": 14, "qty": 2, "modifiers": [ { "name": "Dressed", "price": 0 }, { "name": "Extra shrimp", "price": 3 } ], "notes": "no pickles" },
    { "name": "Gumbo (cup)", "price": 6, "qty": 1, "modifiers": [] }
  ],
  "money": { "subtotal": 40, "tax": 3.9, "delivery_fee": 4.99, "service_fee": 0, "tip": 8, "discount": 0, "surcharge": 1.2, "total": 58.09 },
  "payment": { "type": "card", "status": "paid", "last4": "8598" },
  "notes": "Ring the bell",
  "actor": "dispatcher@pfdworks.com"
}
```

- `restaurant_id` — **either id** (Standing rules); `crm_restaurant_id` is
  accepted as an alias. Unknown to both columns → 422 `restaurant_not_found`.
- `source` — must be `"phone"`.
- `external_id` — the CRM's `phone_orders.id`; with `source`, the
  **idempotency key** (1–128 chars of `[A-Za-z0-9._:-]`).
- `order_number` — optional, 1–20 letters/digits/dashes, what the ticket
  prints as `ORDER #`. Default `P-` + the last six characters of
  `external_id` upper-cased (`P-0B9A87`).
- `order_type` — `delivery` | `pickup`; a delivery needs `customer.address`.
- `due_time` — ISO instant, or `null` for ASAP. Nothing else is guessed.
- `customer.notes` prints as a `>> ` driver instruction under the address
  (the mapper's `street | instructions` convention); `address2` joins the
  street line.
- `items[].price` is the **unit** price in dollars before modifiers;
  `qty` an integer 1–99 (default 1); `modifiers[].price` per unit (0 or
  absent for a free choice); `notes` prints as a modifier line. The ticket
  shows the line total `qty × (price + Σ modifiers)`, like Zuppler's
  `itemTotal`, with the quantity in its own column.
- `money` — dollars, non-negative, cents precision; absent parts are 0.
  **Must reconcile:** `total = subtotal + tax + delivery_fee + service_fee +
  tip + surcharge − discount` to the cent, or 400 `money_mismatch` naming
  the difference — the CRM computed these a moment ago and can fix them; a
  statement months later cannot. `surcharge` is the card surcharge (PFD's
  revenue, not the restaurant's sales); it lands in its own column and is
  part of the component sum in `money_variance`. `total` ≤ $5,000.
- `payment.type` — `cash` | `card` | `house`; `status` — `paid` | `due`;
  `last4` — **exactly four digits** or absent. A longer value is refused,
  never truncated, so a card number arriving here is found out.
- **No card number anywhere.** Every free-text field is checked for a run
  of 13–19 digits (spaces/dashes allowed) → 400 `card_number_rejected`.
- `actor` — the CRM session's email; kept with the order's payload, not
  printed.

**What the ticket says** (`payment_type`, printed bold as its own line, no
`Paid` label, on paper, on the tablet and in the AEM email; never the word
Zuppler; ASCII for the Epson):

| payment | ticket line |
|---|---|
| card · paid · 8598 | `PAID - CARD ****8598` |
| card · paid · no last4 | `PAID - CARD` |
| cash · due | `CASH DUE $58.09` |
| cash · paid | `PAID - CASH` |
| card · due | `CARD DUE $58.09 (CARD ****8598)` |
| house · due | `HOUSE ACCOUNT - DO NOT COLLECT` |
| house · paid | `PAID - HOUSE ACCOUNT` |

**Responses**

| status | meaning |
|---|---|
| `201 { ok: true, created: true, id, order, warning? }` | Stored and delivered per `order.destinations`. `order` is the **list row** `GET /api/crm/orders` returns (so the CRM can show it without a second call); `id` is the bridge's order id. `warning` is present when `destinations` is empty — the order is stored, nobody at the restaurant has been told, say so while the customer is still on the line |
| `200 { ok: true, created: false, id, order }` | **Retry.** This `external_id` already exists with the same contents; nothing was written or re-sent — the kitchen ticket is already out. Safe to retry a timed-out POST |
| `409 external_id_conflict { id }` | This `external_id` exists with **different** contents. An id is not allowed to mean two orders; send a new one |
| `409 order_number_conflict` | A CRM-chosen `order_number` was already used by another order at this restaurant in the last day (the cross-source double-print guard). Nothing was written; pick another |
| `422 restaurant_not_found` | Neither id column knows this restaurant |
| `400 <code>` | The parser refused a field: `invalid_body`, `invalid_source`, `restaurant_required`, `external_id_required`, `invalid_order_number`, `invalid_order_type`, `invalid_due_time`, `customer_required`, `customer_name_required`, `address_required`, `items_required`, `too_many_items`, `invalid_item`, `money_required`, `invalid_money`, `money_mismatch`, `payment_required`, `invalid_payment`, `card_number_rejected` |
| `503` | Bridge misconfigured (`CRM_WRITE_KEY` unset/short/equal to the read key) |

Idempotency is on `(source, external_id)`: the row's `raw_payload` keeps a
fingerprint of the order (everything but `actor`), and a repeat is compared
against it. Neither retry nor conflict re-queues a print job or re-pushes
the tablet; `POST /api/crm/orders/:id/actions` `reprint` / `resend_app`
exist for that.

**Phone orders elsewhere in this contract:** `GET /api/crm/orders` rows
carry `source: "phone"` and `payment_type` as the ticket line above; the
detail's `money` and `GET /api/crm/accounting/orders` rows and `totals`
carry **`surcharge`** (null for every other source) — payouts must treat it
as PFD revenue, not restaurant sales. The detail's `zuppler` object is
`null` for a phone order (nothing to edit in Zuppler); the CRM's Refund and
edit actions live on its own `phone_orders`, not here. The CRM should
feature-flag its caller (`PHONE_ORDERS_ENABLED`) and treat a 404 from this
route as "bridge not deployed yet".

**Menu source: none.** The brief asked for `GET /api/crm/restaurants/:id/menu`
*if* the bridge's Zuppler client can load a menu. It cannot: the only
Zuppler query in this repo is `LoadOrder` (`lib/zuppler-mapper.ts`
`LOAD_ORDER_QUERY`, unauthenticated, against
`orders-api5.zuppler.com/graphql`), which returns one order by uuid — item
names, quantities and prices *as ordered*, never a restaurant's menu, and
the explorer at graphiql.zuppler.com is the only sanctioned way to discover
more fields (the file's own warning: never guess a GraphQL field). No menu
route exists, and the CRM's menu snapshot (O3) imports by other means
(Zuppler channel JSON or manual CSV) until Zuppler answers U1.

**`GET /api/crm/customers/orders`** (added 2026-09-19, prs-crm's
Marketing & Pricing pillar Phase 1): a per-order feed of customer
identity fields (`customer_name`/`customer_phone`/`customer_email`) for
a `from`–`to` date range, plus `order_type`, `items_total` (as
`subtotal`), `payment_type` (as `tender`), and the restaurant's
`zuppler_restaurant_id` for account resolution on prs-crm's side.
Deliberately a SEPARATE route from `/api/crm/accounting/orders` —
that endpoint is fetched broadly by money reconciliation/payout code
with no legitimate need to see customer PII, and adding it there would
widen every caller's exposure, not just the one that needs it. Also
distinct from `/api/crm/orders` (the live tablet/dashboard feed, one
LOCAL DAY at a time, capped, phone redacted on its list view) — this
route is a bulk date-RANGE export, built for a backfill over months of
history rather than "what's on the tablet right now." Same pagination
contract and same internally-chunked, platform-cap-proof `truncated`
computation as `/api/crm/accounting/orders` (see that entry's own
"SAME-DAY CORRECTION"). Excludes `source = 'test'` and cancelled
orders (never a real customer interaction to count in frequency/
lifetime-spend); includes both `zuppler` and `email` sources (the
email-leg parser has no email extraction, but does capture name/phone).

**Customer email backfill, one-time (`scripts/backfill-customer-email.ts`,
2026-09-19).** `customer_email` (migration 041) is populated by the live
mapper going forward, but every order ingested before that fix has it
NULL despite the email having been present in Zuppler's response the
whole time, sitting unread in `raw_payload`. This script re-extracts it
from stored `raw_payload` for every historical Zuppler order, using the
same fallback-shape logic the mapper itself uses (`raw_payload` was not
always captured in one consistent shape). Idempotent (only touches
`customer_email IS NULL` rows); dry-run by default, `--write` to apply.

## Email delivery (Automatic Email Manager restaurants)

Some restaurants print by watching a mailbox with AEM on a local PC rather
than with an Epson. For them the ticket travels as email; AEM prints whatever
arrives.

Writable on `POST /api/crm/restaurants/:id`:

| field | values |
|---|---|
| `print_method` | `printer` (default) \| `email` |
| `ticket_email_to` | the AEM-watched inbox; must be a valid address |

`print_method: "email"` is **refused with 400** unless `ticket_email_to` is
already set or sent in the same request. That configuration would silently
stop every ticket reaching the restaurant, and a refusal at the point of
change is cheaper than discovering it during service.

`GET /api/crm/restaurants` adds `print_method`, `ticket_email_to`, and
`email_delivery_ready` - false when a restaurant is set to email with no
address, so the console can show the problem before an order arrives.

### Test send

```
POST /api/crm/restaurants/:id/test-email
{ "to": "someone@example.com", "order_id": "<uuid>" }
```

Both optional. `to` overrides the destination - this is how a test reaches a
PFD address during setup instead of the kitchen. `order_id` renders a REAL
stored order rather than the built-in sample, which is what proves this
restaurant's own modifiers and totals survive the trip.

Response includes **`sent_to_restaurant`**. Surface it: without `to`, this
sends a real email to a real kitchen, and that should never be ambiguous in
the UI.

### Device test print

`POST /api/crm/devices/:id { "action": "test_print" }` returns **409** on a
device belonging to an email restaurant, pointing at the endpoint above. An
email restaurant has no printer to test.

### What the ticket looks like

Text only - no logo, raster header or QR. Those are bitmaps inside an ePOS
document and have no meaning in a mail body. Sent as `multipart/alternative`:
plain text, plus the same text in a monospace `<pre>`.

Always rendered at **normal** scale even when the restaurant is set to large
print. Enlarged lines lay out at 24 columns because the thermal head draws
them double-width; plain text cannot, so the ticket would come out ragged.

Subject format is a contract with the AEM rule at the restaurant:

```
PFD ORDER #{order_number} - {PICKUP|DELIVERY} {due time}
CANCELLED - ORDER #{order_number}
```

The cancellation subject deliberately does NOT start with `PFD ORDER`, so a
cancellation cannot print as though it were a new order.

### Monitoring

`email_send_failed` is **critical and pages**: an email job older than 5
minutes with no `sent_at`. For an AEM restaurant the email IS the ticket -
there is no queued job waiting on a printer that might come back, and nobody
at the restaurant sees anything at all.

Email restaurants never raise the printer-silence, never-checked-in or
no-printer checks.

## Standing rules

- **Two ids, and `restaurant_id` in CRM calls is the CRM account id; the
  bridge resolves it** (2026-09-17). Every restaurant here has its own
  uuid (`restaurants.id`, what the roster returns as `id`) and the CRM's
  account id beside it (`restaurants.crm_restaurant_id`, what the roster
  returns as `crm_restaurant_id`). They are different values — the bridge
  creates its row with a fresh uuid. Every `/api/crm/restaurants/:id/*`
  path segment, `POST /api/crm/tablets/bind`'s `restaurant_id` and
  `POST /api/crm/tablets/link`'s `restaurant_id` accept **either**; the
  bridge looks both columns up (`lib/restaurant-ref.ts`) and works with
  its own id from there, so the CRM may send `accounts.id` straight from
  its tablets inventory. Responses always carry the bridge's `id`.
- **QR points at the restaurant's own website.** The Zuppler ordering page is
  fallback-only, for restaurants with no site of their own.
- Email delivery is an interim bridge. These sites still move to Epson
  printers later; the printer path is not weakened to support it.
- Large print is a per-station accessibility setting. It is the default for
  all restaurants; a station that wants standard sets `text_scale` on the
  device.
