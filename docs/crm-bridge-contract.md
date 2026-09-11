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
| GET | `/api/crm/restaurants` | — | `{ default_footer_text, restaurants: [...] }` |
| POST | `/api/crm/restaurants/:id` | any subset below | `{ ok, conversions?, restaurant }` |
| POST | `/api/crm/restaurants/:id/ticket-preview` | any subset below | **`image/png`** |

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

`GET /api/crm/restaurants` adds:

| field | meaning |
|---|---|
| `app_expected` | as above |
| `has_active_printer` | whether an active print device exists — a fact, not an intention |
| `destinations` | `["printer"]`, `["app"]`, `["printer","app"]`, `["email","app"]`, or `[]` |

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

Both writes return the password **once**. Nothing retrieves it afterwards -
a forgotten one is replaced, not recovered, because no reset email could ever
reach a derived address.

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

### Test order to the tablet

```
POST /api/crm/restaurants/:id/test-order
```

Sends a test order to the restaurant's TABLET: the screen lights up, chimes,
and the order can be opened and accepted like any other. The only way to know
a newly installed tablet works before a customer finds out it does not.

**Never prints.** The paper path has its own test, and a tablet test that also
produced a ticket would put a fake order on the spike in a working kitchen.
Safe to point at a live restaurant: the order is `source: 'test'`, says on its
face that it is not real, and touches nothing the printer reads.

| status | meaning |
|---|---|
| `200 { ok: true, devices_reached }` | The tablet should be chiming |
| `409` | No device has notifications enabled — checked *before* an order is written, because with nothing to push to the test tells nobody anything |
| `502` | The order was created and reached none of the registered devices — tablet offline, or permission revoked |

It works **before** `app_expected` is turned on, and returns a `warning` saying
so. That order matters: prove the tablet chimes first, then turn
`app_expected` on. Reversed, every order raises a critical `app_alert_failed`
until somebody enables notifications.

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

- **QR points at the restaurant's own website.** The Zuppler ordering page is
  fallback-only, for restaurants with no site of their own.
- Email delivery is an interim bridge. These sites still move to Epson
  printers later; the printer path is not weakened to support it.
- Large print is a per-station accessibility setting. It is the default for
  all restaurants; a station that wants standard sets `text_scale` on the
  device.
