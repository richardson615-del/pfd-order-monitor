# Hexnode call — Wed 2026-09-16, 11:00 CT — one-page prep

**Goal:** leave the call with (1) written tier answers on the 7 must-haves, (2) a 100/250/500 price ladder, (3) a trial portal + a named engineer for the kiosk/private-app/zero-touch walkthrough.

## Our facts to state up front (30 seconds)
- ~100 Android tablets at launch this fall; 500+ restaurants in 12 months.
- One private APK (`com.pfdworks.orders`, a Trusted Web Activity — not on the Play Store), single-app kiosk, tablet always plugged in.
- Devices: Play-certified budget tablets (ZZB ZB10) and/or Samsung Galaxy Tab A9; some bought via a zero-touch reseller, some hand-enrolled by QR.
- Our CRM will poll their API every 10 min for inventory + device status.

## Must-haves — get the tier for each, in writing after the call

| # | Must-have | What "yes" looks like | Watch for |
|---|---|---|---|
| 1 | Android Enterprise fully-managed / dedicated device + single-app kiosk (lock task) on our own APK | Pro | "Kiosk browser" ≠ our app in lock task; confirm it's our APK pinned |
| 2 | Silent install **and** silent update of an uploaded private APK | Pro; no Play Store publishing required | Some vendors require managed-Play private app for updates |
| 3 | Android zero-touch enrolment | State the tier definitively — their help center lists it under both Pro and Enterprise | If Enterprise-only: ask for Pro pricing + ZTE as add-on, or Enterprise at Pro-ish volume price |
| 4 | REST API: device list, device details/last-seen, installed apps + versions, restart, enrolment | Pro; per-portal key; rate limit ≥ 1 full device-list pull per 10 min at 500 devices | Per-seat API pricing; rate limits that break a 10-min poll |
| 5 | Policies: screen on while charging, auto-launch on boot, Wi-Fi profile push, volume lock, OS-update maintenance window | Pro | "Screen on" via kiosk setting vs. Android policy — either is fine if it survives reboot |
| 6 | Remote view / remote control | Which tier; per-device price | Enterprise ($3.20) = view; Ultimate ($4.70) = control per their site |
| 7 | Fire OS support limits | Just for the record | — |

## Commercials — targets
- List: Pro $2.20/dev/mo (≈$23.76/yr annual). **Ask:** 100-seat entry price, with a **pre-agreed** step price at 250 and 500 (not "call us later"). Target ≤ $20/dev/yr at 100, ≤ $17 at 500.
- Monthly billing now, convert to annual at 250 without re-enrolment or re-licensing.
- Mid-term seat adds at the same unit price.
- Zero onboarding/implementation fee — or fee waived for a 100-seat start.
- Support level included; named CSM; response SLA.
- Ask directly: "Who do you lose deals to at this size, and why?" (they'll say Esper/Scalefusion — note what they concede.)
- Leverage: an Esper Bridge quote is in progress ($4/dev/mo list). Don't share our target numbers first.

## Technical questions for their engineer
1. Zero-touch: which zero-touch reseller portal flow, and can one profile apply to both ZTE and QR-enrolled devices?
2. Private APK: upload size limit, versionCode rules, staged rollout by group (we want 5 → 50 → all).
3. Does a silent APK update restart the app? Does the kiosk relaunch it automatically?
4. API: pagination, auth (API key vs OAuth), rate limits, does `last_seen` update on heartbeat or only on check-in? Sandbox/trial API access with a read-only key?
5. Play-certified but non-Samsung budget tablet (ZB10): any known issues with device-owner provisioning or kiosk on low-RAM devices?
6. Can the kiosk policy pin our app **and** allow the Android notification shade off — we handle alerts inside the app.
7. Wi-Fi: per-device or per-group Wi-Fi profiles; hidden SSIDs; how a restaurant staffer changes Wi-Fi if the store's router changes (we need a locked-down way).
8. What happens if a tablet is offline for 30 days and comes back — does it re-sync policies and pending app updates automatically?
9. Data residency / retention for device telemetry; SOC 2 report available?
10. Exit: can we bulk-unenrol and export inventory if we leave?

## Red flags (walk away or escalate)
- Zero-touch only on Ultimate/Ultra.
- API metered per call or gated behind a paid add-on.
- Silent update requires publishing to managed Google Play (not a deal-breaker, but changes our release process).
- No willingness to write down the 250/500 step price.

## Bring / have open
- The ZB10 unit (Play-certified), charged, factory-reset ready — ask them to enrol it live on the call.
- Our current APK (`public/app/pfd-orders.apk`) to upload to the trial portal.
- `pfd-order-monitor/docs/mdm-plan.md` for the comparison table.

## After the call
- Email them the 7 must-haves as a recap and ask for confirmation in writing (this becomes the exhibit to the order form).
- Start the 14-day trial on a `pfdworks.com` mailbox; run the 7-day burn-in on the ZB10.
- Send the same must-haves to Esper for the competing quote.
