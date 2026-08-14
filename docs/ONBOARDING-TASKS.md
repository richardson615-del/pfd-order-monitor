# Restaurant onboarding — CRM task template

Nine tasks, in dependency order. Titles are short enough for a CRM task list;
each has an owner, a description, and an acceptance check so nobody closes a
task on a half-finished setup.

Tasks 2 and 4 are the only ones that can block on someone outside the team.
Start them first.

---

### 1. Collect onboarding details
**Owner:** Account manager
**Blocked by:** —

Confirm with the restaurant:
- Exact name as it should print on the ticket (e.g. "Depot Bar and Grill")
- A short slug for internal use, lowercase with hyphens (e.g. `depot-bar-grill`)
- How they receive orders: Zuppler, PFD order emails, or both
- Who at the restaurant will use the dashboard, and their email

**Done when:** all four are recorded on the CRM record.

---

### 2. Find the Zuppler restaurant ID
**Owner:** Account manager
**Blocked by:** Task 1 (only needed if they take Zuppler orders)

Find any past order receipt for this venue - our own archive is fine. Copy the
"View your receipt" link out of the email.

In `/admin` → **Find a Zuppler restaurant ID**, paste the link and press
**Look up**. The five-digit ID comes back, e.g. `29905`, along with the order it
came from so you can confirm it is the right venue.

You can do this before the restaurant has ever ordered through us. Only ask
Jerry Dani at Zuppler if no receipt exists at all - the ID appears nowhere else
and cannot be guessed.

**Done when:** the five-digit ID is recorded on the CRM record.

---

### 3. Confirm the printer is on site and networked
**Owner:** Account manager
**Blocked by:** Task 1

The restaurant needs an Epson TM-m30III, powered on and connected to their
network by ethernet. USB-only will not work.

To find its IP later, hold the **Feed** button while switching the printer on —
it prints a status sheet showing the address.

**Done when:** the printer is on their network and you have its IP.

---

### 4. Create the restaurant
**Owner:** Ops
**Blocked by:** Tasks 1, 2

Go to https://pfd-order-monitor.vercel.app/admin → **Add a restaurant**.

Enter the name and slug, then whichever routes apply: the Gmail address
receiving their orders, the Zuppler restaurant ID, or both. One of the two is
required — they are the only ways an order can reach this restaurant.

**Done when:** the restaurant appears in the Restaurants table with its Zuppler
ID shown.

---

### 5. Connect their inbox
**Owner:** Ops, with the restaurant present
**Blocked by:** Task 4 — skip entirely for Zuppler-only venues

In `/admin`, find the restaurant's row and click **Connect Gmail**. The
restaurant signs in to their own Gmail account and grants read-only access. We
never see or store their password, so they need to be at the keyboard.

**Done when:** the Gmail status column reads **Connected**.

---

### 6. Register the printer
**Owner:** Ops
**Blocked by:** Task 4

In `/admin` → **Print devices**, select the restaurant, name the device (e.g.
"Kitchen printer"), and press **Register device**.

A device key appears: `PFD-XXXX-XXXX-XXXX`. **Copy it immediately** — it is
shown once and cannot be recovered. Losing it means registering a new device
and deactivating the old one.

**Done when:** the key is saved somewhere you can reach during task 7, and the
device is listed under the correct restaurant.

---

### 7. Point the printer at us
**Owner:** Ops, on site or over the phone
**Blocked by:** Tasks 3, 6

Open `http://<printer-ip>/webconfig/` in a browser on the restaurant's network,
then go to **Web Service Settings → Direct Print** and set:

- Server Direct Print: **Enable**
- ID: the device key from task 6
- Server 1 URL: `https://pfd-order-monitor.vercel.app/api/print/epson`
- Interval (s): `5`

Press **Access Test** before saving.

**Done when:** the device's **Last seen** in `/admin` reads "just now".

---

### 8. Print a real order
**Owner:** Ops
**Blocked by:** Task 7

Have the restaurant place a genuine test order, or replay a recent one. A
device check-in only proves the printer is reachable, not that the ticket is
correct — do not skip this.

Check the printed ticket for:
- The restaurant's own name at the top, not "PFD ORDER"
- Delivery address present on delivery orders
- Items, quantities and modifiers matching the order
- TOTAL matching the customer's receipt to the cent
- A "TIP (driver)" line where a tip was left
- No "** CHECK TOTALS **" banner

**Done when:** a correct ticket is in hand and the order shows as printed on the
dashboard.

---

### 9. Hand over to the restaurant
**Owner:** Account manager
**Blocked by:** Task 8

- In `/admin` → **Invite a restaurant login**, send a magic-link invite to their
  staff email. There is no password to manage.
- Have them open the site on the tablet or phone they will use and add it to the
  home screen — Chrome on Android, Safari on iPhone. It then behaves like an app.
- Have them tap **Enable notifications** once on the dashboard. On iPhone this
  only works after adding to the home screen.

**Done when:** they have signed in, installed it, and confirmed they received a
notification for the test order.

---

## Escalate to an engineer if

- A restaurant is fully set up and an order appears on the dashboard but never
  prints — usually means no active print device for that restaurant.
- Order emails are arriving in their inbox but no orders appear — the inbox may
  predate August 2026 and still use the older subject pattern.
- A printed total does not match the customer's receipt.
- **Last seen** for a device has gone red and power, network and paper are all fine.
