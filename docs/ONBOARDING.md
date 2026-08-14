# Onboarding a restaurant onto Order Monitor

Everything between "restaurant signed" and "tickets printing in their kitchen".
Six steps, in order - each depends on the one before it. ~20 min per restaurant.

A formatted version of this runbook is published for the ops team; this file is
the source of truth. Keep them in step.

## Before you start

Two of these come from outside the team - chase them first.

| | |
|---|---|
| **Restaurant name** | As it should print on the ticket, e.g. `Depot Bar and Grill` |
| **Order sources** | Zuppler, PFD order emails, or both. Decides steps 2 and 3. |
| **Zuppler restaurant ID** | Five digits, e.g. `29905`. **Ask Jerry Dani at Zuppler** - not guessable, not in any email. |
| **Gmail address** | Email venues only. The restaurant must sign in to it during step 3. |
| **Printer** | Epson TM-m30III on their network with power. Not USB-only. |

## 1. Create the restaurant — admin panel

`/admin` → **Add a restaurant**. Name, unique slug, and the Gmail address
receiving their orders.

**Known gap:** the form requires a Gmail address, so a Zuppler-only restaurant
cannot be created here yet. Create it directly, then continue at step 2:

```sql
insert into restaurants (name, slug, is_active) values ('China One', 'china-one', true);
```

*Done when* the restaurant appears in the Restaurants table.

## 2. Map the Zuppler restaurant ID — database

One webhook covers every venue; orders are routed purely on this number.

```sql
update restaurants set zuppler_restaurant_id = '29905' where slug = 'china-one';
```

Skip only if the restaurant takes no Zuppler orders.

**Silent failure if skipped:** unmapped orders are accepted then dropped.
Zuppler sees success and never retries; nothing reaches the dashboard and nobody
is told. The real ID is logged (`no restaurant mapped for zuppler_restaurant_id
…`) and the order is replayable once mapped - but only if someone looks.

*Done when* the query returns `UPDATE 1`.

## 3. Connect their inbox — admin panel

Email venues only. `/admin` → **Connect Gmail** on the restaurant's row. The
restaurant signs in to their own Gmail; we never see their password.

Then confirm the subject pattern covers both formats PFD sends:

```sql
update monitored_inboxes
set subject_pattern = '^(?:Order\s+(\d+)|([0-9a-f]{8})\s*:)'
where email_address = 'their@gmail.com';
```

*Done when* Gmail status reads **Connected**.

## 4. Register the printer — admin panel

`/admin` → **Print devices** → pick the restaurant, name the device, **Register
device**.

The key `PFD-XXXX-XXXX-XXXX` is shown **once** and cannot be recovered. A lost
key means registering a new device and deactivating the old one.

*Done when* the key is copied and the device is listed under the right restaurant.

## 5. Point the printer at us — printer web config

Hold **Feed** while switching the printer on to print its IP. Open
`http://<printer-ip>/webconfig/` → **Web Service Settings → Direct Print**.

| Field | Value |
|---|---|
| Server Direct Print | `Enable` |
| ID | the device key from step 4 |
| Server 1 URL | `https://pfd-order-monitor.vercel.app/api/print/epson` |
| Interval (s) | `5` |

Press **Access Test** before saving.

*Done when* the device's **Last seen** in `/admin` reads **just now**.

## 6. Print a real order — end to end

Have them place a genuine test order, or replay a recent one. A device check-in
proves the printer is reachable, not that a ticket is correct. Check the paper for:

- The restaurant's **own name** at the top, not "PFD ORDER"
- **Delivery address** on delivery orders
- Items, quantities and modifiers matching the order
- **TOTAL** matching the customer's receipt to the cent
- A **TIP (driver)** line where a tip was left
- No `** CHECK TOTALS **` banner

*Done when* a correct ticket is in hand and the order shows as `printed`.

## Hand over to the restaurant

- **Invite their login** - `/admin` → Invite a restaurant login (magic link, no password).
- **Install the app** - open the site in Chrome (Android) or Safari (iPhone), "Add to Home Screen".
- **Enable notifications** - they tap it once on the dashboard. On iPhone this only works after installing to the home screen.

## Where it fails silently

Every row produces no error and no alert. This is the checklist for "we didn't
get the order".

| | What happened | How you'd notice | Fix |
|---|---|---|---|
| Silent | No print device for that restaurant | Order on dashboard, no paper | Step 4 |
| Silent | Zuppler ID not mapped | Nothing on the dashboard at all | Step 2, then replay |
| Silent | Subject pattern doesn't match | Emails arrive, no orders appear | Step 3 |
| Silent | Order email went to spam | Nothing appears | Handled - spam is polled |
| Visible | Gmail access expired | Status stops saying Connected | Reconnect in `/admin` |
| Visible | Printer stopped checking in | **Last seen** turns red | Power, network, paper |
| Silent | Paper loaded upside down | Blank paper feeds and cuts normally | Flip the roll |

## Quick reference

| Thing | Where |
|---|---|
| Admin panel | `https://pfd-order-monitor.vercel.app/admin` |
| Printer endpoint | `https://pfd-order-monitor.vercel.app/api/print/epson` |
| Zuppler contact | Jerry Dani - restaurant IDs, webhook channels |
| Logs | Vercel → pfd-order-monitor → Logs |
| Known Zuppler IDs | `29905` China One · `29974` mapped to Yummy Johns |

Steps 2 and 3 still require database access. Everything else is doable from the
admin panel by someone non-technical.
