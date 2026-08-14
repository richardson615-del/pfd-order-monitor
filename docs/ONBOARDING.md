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
| **Zuppler restaurant ID** | Five digits, e.g. `29905`. Look it up in `/admin` from any past receipt for that venue; ask Jerry Dani at Zuppler only if no receipt exists. |
| **Gmail address** | Email venues only. The restaurant must sign in to it during step 3. |
| **Printer** | Epson TM-m30III on their network with power. Not USB-only. |

## 1. Create the restaurant — admin panel

`/admin` → **Add a restaurant**. Name, unique slug, then whichever routes apply:
the **Gmail address** receiving their orders, the **Zuppler restaurant ID**, or
both.

One of the two is required - they are the only ways an order can reach this
restaurant. A Zuppler-only venue leaves the inbox blank.

*Done when* the restaurant appears in the Restaurants table with its Zuppler ID.

## 2. Check the Zuppler restaurant ID — admin panel

One webhook covers every venue; orders are routed purely on this number.

If you entered it in step 1, confirm it in the **Restaurants** table. To add or
correct one, click the ID (or **Set ID**) and type the new value. Digits only -
a typo is rejected rather than silently dropping orders later.

Don't have the ID? Use **Find a Zuppler restaurant ID** on the same page: paste
the "View your receipt" link from any past order email for that venue and it
returns the ID, with a one-click assign. Zuppler's API has no restaurant
lookup - every ID comes from an order - so a receipt is the fastest route.

Skip only if the restaurant takes no Zuppler orders.

**Silent failure if skipped:** unmapped orders are accepted then dropped.
Zuppler sees success and never retries; nothing reaches the dashboard and nobody
is told. The real ID is logged (`no restaurant mapped for zuppler_restaurant_id
…`) and the order is replayable once mapped - but only if someone looks.

*Done when* the correct five-digit ID shows against the restaurant.

## 3. Connect their inbox — admin panel

Email venues only. `/admin` → **Connect Gmail** on the restaurant's row. The
restaurant signs in to their own Gmail; we never see their password.

Nothing else to configure: new inboxes already match both subject formats PFD
sends. Inboxes created before August 2026 may still be on the older pattern and
should be checked by an engineer.

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
| Zuppler contact | Jerry Dani - webhook channels; restaurant IDs only if no receipt exists |
| Logs | Vercel → pfd-order-monitor → Logs |
| Known Zuppler IDs | `29905` China One · `29974` mapped to Yummy Johns |

Every step here is doable from the admin panel - no database access needed.
Escalate to an engineer only for an inbox created before August 2026, or if a
correctly-configured restaurant still isn't printing.
