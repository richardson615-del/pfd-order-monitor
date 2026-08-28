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

## Standing rules

- **QR points at the restaurant's own website.** The Zuppler ordering page is
  fallback-only, for restaurants with no site of their own.
- Large print is a per-station accessibility setting. It is the default for
  all restaurants; a station that wants standard sets `text_scale` on the
  device.
