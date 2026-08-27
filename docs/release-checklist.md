# Release checklist

Two parts: **system gates** that must hold once, before any restaurant goes
live, and a **per-restaurant recipe** repeated for every venue.

Nothing here is theoretical. Every gate exists because the corresponding
failure actually happened during build-out, and every one of them failed
*silently* - the order reached the dashboard, or didn't, and nobody was told.

---

## Part 1 - System gates (once, before first live restaurant)

### G1. Alerts are delivered somewhere
Detection has been working for a while; delivery is what makes it real. An
alerting system nobody receives is indistinguishable from no alerting.

- [ ] `ALERT_WEBHOOK_URL` set (Slack/Discord) - receives **everything**
- [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_SMS_TO` set - receives **criticals only**
- [ ] A test alert has actually arrived on a phone, not just returned 200

### G2. The alert store is writable
Without it every run re-alerts, which trains people to mute the channel.

- [ ] `monitor_alerts` table exists (migration 005)
- [ ] Two consecutive `/api/monitor/check` runs report `new: 1` then `new: 0`

### G3. Nothing is watching the watcher
If the monitoring cron stops, silence looks exactly like health.

- [ ] Decide: external dead-man's switch (e.g. a healthcheck ping) or accept the risk **in writing**

### G4. Production data is production-only
- [ ] Test restaurants and test orders removed, or clearly marked and excluded from alerts
- [ ] No test inbox left active on a real restaurant

### G5. Zuppler webhook covers every live channel
The webhook is enabled per channel. A restaurant on an uncovered channel
takes orders that never reach us - with no error anywhere.

- [ ] Channel id for every live restaurant is known (see the audit query below)
- [ ] Each has a webhook row in the Zuppler portal
- [ ] Verified by a real order arriving, not by configuration alone

---

## Part 2 - Per-restaurant go-live

Run in order. Each step's check is the evidence that it worked - a step is not
done because it was performed, only because the check passed.

### R1. Restaurant exists and is routable
- [ ] Created in `/admin` with its exact trading name (**this prints on the ticket**)
- [ ] Zuppler restaurant id recorded (look it up from any past receipt via **Find a Zuppler restaurant ID**)
- **Check:** the restaurant appears with a five-digit Zuppler id

### R2. Webhook coverage confirmed for its channel
- [ ] Channel id identified
- [ ] Webhook row added in the Zuppler portal for that channel
- **Check:** a real order produces a `POST /api/ingest/zuppler` in the Vercel logs.
  Configuration alone is not evidence.

### R3. Printer configured
- [ ] Device registered in `/admin`; key copied (**shown once**)
- [ ] Printer's WebConfig -> Web Service Settings -> Direct Print: enabled, ID = device key,
      Server 1 URL = `https://pfd-order-monitor.vercel.app/api/print/epson`, interval 5s
- **Check:** the device's **Last seen** reads "just now" in `/admin`

### R4. Verified test print
A device checking in proves the printer is reachable. It does **not** prove a
ticket is correct, and the difference has bitten us more than once.

- [ ] A real order printed on that restaurant's printer, and the paper shows:
  - [ ] the restaurant's own name (not "PFD ORDER")
  - [ ] delivery address on delivery orders
  - [ ] items, quantities and modifiers matching the order
  - [ ] total matching the customer's receipt **to the cent**
  - [ ] a `TIP (driver)` line where a tip was left
  - [ ] no `** CHECK TOTALS **` banner
- **Check:** the order shows `printed` on the dashboard

### R5. Notification path confirmed
- [ ] Staff login invited and signed in
- [ ] App added to the home screen on the device they will actually use
- [ ] **Enable notifications** tapped once (on iPhone this only works after installing)
- **Check:** they confirm a notification arrived for the test order

### R6. Failure path understood
- [ ] Someone at the restaurant knows what to do if the printer stops (who to call)
- [ ] The device shows in `/admin` with a live **Last seen**, so an outage is visible

---

## Audit: which channels carry live orders

Channel id is not a column; it lives in the stored payload.

```sql
select
  r.name,
  o.raw_payload->'data'->'order'->'carts'->0->>'channelId'  as channel_id,
  r.zuppler_restaurant_id,
  count(*) as orders,
  max(o.received_at) as last_order
from orders o
join restaurants r on r.id = o.restaurant_id
where o.source = 'zuppler'
group by 1,2,3
order by last_order desc;
```

Any restaurant whose channel does not appear in the Zuppler portal's webhook
list is taking orders that never reach us.

---

## Known limits, accepted deliberately

Written down so they are decisions rather than surprises.

- **One printer per restaurant, no failover.** A dead printer means no tickets
  until someone acts. Alerts make it visible; they do not make it redundant.
- **Zuppler restaurant notifications cannot be ingested from email.** They
  carry no receipt link, and their only links are "Accept Order"/"Reject
  Order", which must never be followed automatically. The webhook is the
  ingest path; email can only ever be a cross-check that one failed to fire.
- **Order adjustments do not reprint.** A tip added after the fact updates the
  stored order but does not produce a second ticket - deliberate, since
  reprinting risks the food being made twice.
- **Zuppler's API is read-only.** One query, `order(id)`; no mutations, no
  channel listing. Webhook coverage cannot be audited programmatically - only
  inferred from orders that arrived.
