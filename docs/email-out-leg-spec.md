# Email-out delivery leg (Automatic Email Manager bridge)
Repo: pfd-order-monitor. Date: 2026-09-04.
## Goal
Some restaurants still print orders via Automatic Email Manager (AEM) on a local
computer. For restaurants with `print_method = 'email'`, every routable order
sends the rendered plain-text ticket by email to the restaurant's AEM-watched
inbox instead of queuing an Epson print job. AEM prints it unchanged, so the
kitchen gets the standard PFD ticket format with no hardware change.
This is an interim bridge. These sites still move to mailed pre-configured
Epson printers later; do not weaken the printer path to build this.
## Data (migration 016)
- `restaurants.print_method` text, `'printer' | 'email'`, default `'printer'`.
- `restaurants.ticket_email_to` text, nullable.
- `print_jobs.delivery` text, `'epson' | 'email'`, default `'epson'`.
- `print_jobs.sent_at` timestamptz, nullable.
- `print_jobs.send_error` text, nullable.
No new tables. print_jobs stays the single system of record so monitoring and
the CRM Printers console keep working.
## Flow
- At the point where a routable order fans out to print devices, branch on
  `restaurants.print_method`:
  - `printer`: unchanged.
  - `email`: create exactly one `print_jobs` row with `delivery='email'` and
    send immediately (or via the existing queue worker, whichever is simpler
    and idempotent).
- Sender: existing Gmail integration, sending as info@pfdworks.com.
- Subject: `PFD ORDER #{order_number} - {PICKUP|DELIVERY} {due_time}`.
- Body: output of the existing `renderTicket()` text renderer, delivered as
  a plain-text part and an HTML part wrapping the same text in `<pre>` with a
  monospace font. Text-only: no raster header, logo, or QR footer (those
  require the Epson path).
- Cancellations: send a second email, subject `CANCELLED - ORDER #{n}`,
  mirroring how queued Epson jobs are killed today.
- Idempotent per job row: never send twice for one external_id.
## Monitoring
- Add `email_send_failed` to the detection function: a job with
  `delivery='email'` older than 5 minutes with no `sent_at`. Critical tier,
  same SMS path. Add assertions alongside the existing ones.
- Restaurants with `print_method='email'` must NOT trip the printer-silence,
  never-checked-in, or routable-but-printerless checks.
## Bridge + console
- GET/POST `/api/crm/restaurants` expose `print_method` and `ticket_email_to`.
- CRM printer page (prs-crm, separate session) gets the toggle and address
  field. "Test print" on an email restaurant sends a sample ticket to
  `ticket_email_to`.
- Publish the updated bridge contract so the CRM session can build against it.
## First restaurant: Greek Style Gyro (Springfield, TN)
- `restaurants.id = 72cdb75e-635c-4e9f-a921-ed6b4626908b`
  (`zuppler_restaurant_id 29895`, already mapped and webhook-covered).
- `print_method = 'email'`
- `ticket_email_to = greekstylegyrosp@gmail.com`
- Reference order for the acceptance test:
  `orders.id 1c4bef1f-a116-444e-bf70-c540321ef76a`
  (external_id 134d542b..., Sep 3 pickup, 3 items with modifiers and
  free-text comments such as "no beef - only chicken & lamb").
- Render that order through the email path as the acceptance test before any
  live send. Test sends go to richardson615@gmail.com first.
- Do NOT send to the restaurant until Matt confirms the AEM rule has been
  switched (print only mail from info@pfdworks.com with subject starting
  "PFD ORDER") and the raw Zuppler notification rule is off. Otherwise the
  restaurant gets two tickets per order.
## Rollout checklist per email restaurant
1. Set `print_method='email'` and `ticket_email_to`.
2. Change the AEM rule at the restaurant (above).
3. Test print from the console, confirm one ticket in PFD format.
4. Watch the next real order: exactly one ticket, no duplicate, no miss.
## House rules
- Hand Matt the migration SQL to run himself; do not assume it ran.
- No secrets in chat. Env var names only; Matt sets values.
- Confirm before anything irreversible.
