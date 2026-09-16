# MDM for Premium Orders tablets — vendor pick and what it takes

Date: 2026-09-15. Prices are vendor list prices read the same day; sources at the end. FACT = verified on the vendor's page. ASSUMPTION/UNKNOWN labelled.

## 1. Answer: which tablets work

**Any GMS-certified Android tablet** (has Google Play, Android 8+; prefer Android 11+ for 4–5 more years of Chrome updates) works with every MDM below via Android Enterprise "fully managed / dedicated device" mode. Brand does not matter — Samsung, Lenovo, TCL, Nokia, Motorola all fine. Two exceptions:

| Tablet type | Works? | Why |
|---|---|---|
| Samsung Galaxy Tab A9 / A9+, Lenovo Tab M-series, any Play-Store tablet | **Yes** | GMS → Android Enterprise, QR enrolment, silent APK push, kiosk |
| **Amazon Fire** | **No (avoid)** | No Google services → no Android Enterprise, no zero-touch, no silent install in most MDMs; only Hexnode and Fully Kiosk acknowledge Fire OS and both list limitations |
| Restaurants' existing tablets already in use | Yes, **but** enrolment needs a **factory reset** (QR/afw# enrolment only runs in the setup wizard) | Fits the attrition model: enrol new shelf stock now; existing tablets get enrolled when they're replaced or on a planned reset |

**ZZB ZB10 (Nick's candidate, checked 2026-09-15):** Play Protect shows *Device is certified* on the unit in hand → Hexnode can fully manage it (kiosk lock, silent APK install/update, remote reboot). Trade-offs: no zero-touch (ZZB is not a Google zero-touch OEM → every unit is a ~5-min hand QR enrolment), no OS security updates from the OEM, Amazon/Walmart returns only, and the "ZB10" name has shipped as both Android 10/2 GB and Android 15/8 GB. Acceptable as **pilot and spares**; acceptable as **fleet standard only if** all 100 are bought as one hardware revision in one batch and it passes the 7-day burn-in below. Otherwise Galaxy Tab A9 / Lenovo M-series remain the recommendation.

**7-day burn-in before any bulk buy (one unit):** enrol by QR into the Hexnode trial → Kitchen-tablet profile applies (kiosk on `com.pfdworks.orders`, screen stays on while charging, auto-launch on reboot) → push a second APK build silently and confirm the app updates without touching the tablet → run 7 days plugged in with test orders: chime + system notification every time, heartbeat never drops >5 min on stable Wi-Fi, no thermal throttling/screen dimming, battery not swollen or hot → remote reboot from the console works. Any failure = not the fleet device.

Zero-touch enrolment (tablet enrols itself on first boot with no QR) requires buying from an Android zero-touch reseller, not a consumer store. With ~100 units in the first buy, **order through a zero-touch reseller from day one** — QR-enrolling 100 tablets by hand is a full week of someone's time; zero-touch makes it unboxing.

## 2. Vendor pick — planned for 500+ restaurants (revised 2026-09-15)

Nick's scale (2026-09-15): **~100 tablets at launch**, 500+ restaurants within a year. That changes the shortlist: the free tiers stop mattering, and what matters is (a) a **public REST API** so the CRM syncs inventory/status automatically, (b) **zero-touch enrolment** so tablets bought in bulk enrol themselves on first boot, (c) list price at 100/250/500 and willingness to negotiate.

| | Hexnode UEM | Esper | Scalefusion | Miradore | AirDroid Business |
|---|---|---|---|---|---|
| Tier that has kiosk + silent private APK + API | **Pro** $2.20/dev/mo (−10% annual ≈ $23.76/yr) — ZTE tier ambiguous (Pro vs Enterprise $3.20) | **Bridge** $4/dev/mo ($48/yr); 25-device min | **Business** $5/dev/mo ($60/yr), annual only | **Premium+** $3.95/mo annual ($47.40/yr) | No public API found — **excluded** |
| List $/yr @100 | **$2,376** (Enterprise: $3,456) | $4,800 | $6,000 | $4,740 | — |
| List $/yr @250 | **$5,940** (Enterprise: $8,640) | $12,000 | $15,000 | $11,850 | — |
| List $/yr @500 | **$11,880** (Enterprise: $17,280) | $24,000 | $30,000 | $23,700 | — |
| Public REST API | Yes (devices, details, apps, restart, enrolment) | Yes (v2 devices, commands incl. reboot, apps) | Yes (cleanest) | Yes (v2, Swagger) | UNKNOWN |
| Zero-touch | Yes | Yes | Yes (all tiers) | Yes | Yes |
| Webhooks for offline/online | No (email/in-product triggers) | No (email alerts) | Webhooks on Enterprise, but no online/offline event | No | No |
| Fire OS | Yes (limited) | AOSP via ADB | UNKNOWN | No | UNKNOWN |

All five say "contact sales" for volume pricing; at 250+ expect meaningful discounts off list — get quotes from Hexnode and Esper together and play them against each other.

**Recommendation: Hexnode UEM, Pro tier (upgrade to Enterprise only if Android zero-touch turns out to be Enterprise-gated — confirm with their sales in writing before signing).** It is the cheapest option that has everything the 500-restaurant plan needs: single-app kiosk, silent private-APK install/update, a documented REST API for the CRM sync (D2), zero-touch, Fire OS as a fallback, monthly billing; the 15-device minimum is irrelevant at a 100-unit start — negotiate the 100-seat price as the entry point with a pre-agreed step to 250/500. At list it is ~$12k/yr at 500 tablets vs $24k for Esper. Esper Bridge is the fallback if Hexnode's ZTE answer or trial experience disappoints — better device-fleet tooling and AOSP support, at double the price.

Not viable: **building our own MDM on Google's Android Management API** — Google's permissible-usage policy restricts it to commercial EMM providers and explicitly prohibits "solutions developed and used exclusively for first party in-house applications"; the default quota is also 500 devices. Miradore Free (50-device cap) is now a trial tool at most.

Because no vendor emits an online/offline webhook, the CRM will **poll** the MDM device list every 5–10 minutes (D2). The tablet app's own 2-minute heartbeat to the bridge (D1) remains the primary liveness signal; the MDM is the inventory + shell-version source of truth.

**Buy tablets through an Android zero-touch reseller** once ordering in lots (Samsung Galaxy Tab A9/A9+ or Lenovo Tab M-series via CDW, Insight, SHI, etc.). Zero-touch means a tablet fresh from the box connects to Wi-Fi and enrols itself into the "Kitchen tablet" profile — no QR, no office step — which is what makes 500 feasible with a small team.

## 3. What we have to do — checklist

**A. Accounts (Nick, ~1 hour + sales call)**
0. Get written confirmation from Hexnode sales: which tier includes Android zero-touch and silent enterprise-app install; volume pricing at 100/250/500; API rate limits. Get an Esper Bridge quote in parallel for leverage.
1. Create the MDM account under `play@pfdworks.com` or another `pfdworks.com` mailbox (not a personal Gmail) — the MDM binds a **managed Google Play** enterprise to that Google account, and that binding is what enables silent app installs.
2. Complete the managed Google Play enterprise setup inside the MDM (it prompts for it).

**B. App (Claude Code, Workstream C in the repo)**
3. Ship C1 (Premium brand) and produce the signed release APK/AAB, `appVersionCode 3`, attached to the GitHub release. Same signing key as today.
4. Ship C4 §1 (silent web refresh) so web changes never need the MDM at all.
5. Confirm the app runs correctly as a locked single-app kiosk: `startUrl /dashboard`, survives reboot, session persists across an APK update. Record in the PR.

**C. MDM configuration (one time, ~2 hours)**
6. Upload `premium-orders-3.apk` as an **enterprise/private app**; set install = required, update = automatic/silent.
7. Build one **device profile** "Kitchen tablet": single-app kiosk on `com.pfdworks.orders`; screen timeout = never while charging; auto-launch on boot; block status bar/nav; Wi-Fi profile for the store (per-restaurant profiles or a template); disable OS auto-updates during service hours or set a maintenance window; volume locked at max; time zone auto.
8. Generate the **enrolment QR** for that profile (used for existing/reset tablets); link the zero-touch reseller account to the MDM so bulk-bought tablets enrol on first boot.

**D. Per-tablet flow (~5 minutes each, at the office before it ships)**
9. Zero-touch tablets: power on, join Wi-Fi, done. Others: factory-reset, tap the welcome screen 6 times → scan QR → tablet enrols, joins Wi-Fi, installs Premium Orders, locks into kiosk.
10. Sign in with the restaurant's tablet login (or print it from the CRM to the store's printer — Workstream B). Tap **Turn on alerts** once (C3). Done.
11. Label the tablet; record serial → restaurant in the MDM's device name so the CRM/MDM lists line up.

**E. Ongoing**
12. New shell version: upload APK to the MDM → it pushes to every tablet. No one at a restaurant does anything.
13. Tablet dies: pull one from shelf stock, steps 9–11, ship it.

## 4. Notification pre-grant — verified 2026-09-16 (supersedes the 09-15 correction)
FACT (trial tablet, Nick, 2026-09-16): Hexnode's **App Permissions** policy pre-grants the app's notification permission — **Policies → Apps → App Permissions → Premium (`com.pfdworks.orders`) → Send push notifications: Allow** — and the TWA reads it as `Notification.permission === "granted"` on first run. The one "Turn on alerts" tap is gone on a managed tablet; the gate's `ask` state now only appears on an unmanaged browser. (The 09-15 note below it was right about Chrome's `NotificationsAllowedForUrls` — that policy is irrelevant here because the permission is the *app's*, and Hexnode grants app permissions.)

Consequence for the app (PR `fix/kiosk-alert-copy`): the gate's `blocked` state can no longer tell anyone to open Android Settings — a kiosk has none. It says *"Alerts are off on this tablet — call Premium on (615) 619-5081"*, reports `alert_state: "blocked"` on the heartbeat (migration 037, relayed to the CRM as `tablet.alert_state`), and re-checks once a minute so re-applying the policy from the console brings the gate down with nobody at the tablet.

### What the Hexnode policy for `com.pfdworks.orders` must contain
The same three lines as `docs/kiosk.md` "What the Hexnode policy must set"; the app and the CRM assume all three:

1. **Required App** — `com.pfdworks.orders` from the uploaded enterprise APK, required, silent install + update.
2. **App Configuration** — key `device_ref`, value `%serialnumber%` (payload in `docs/hexnode-app-config.json`). This is what makes a tablet boot into its restaurant with nothing typed: the CRM's `tablets.serial` comes from the Hexnode device record (D2 sync), the CRM pushes `serial → restaurant` to the bridge, and the shell hands the same serial to the page.
3. **App Permission** — Send push notifications: **Allow**.

## 5. Facts not verified (UNKNOWN)
- Hexnode: exact tier for Android zero-touch (help center lists it under both Pro and Enterprise) and for silent enterprise-app install; API rate limits.
- Esper: whether Bridge is annual-only; whether private-APK silent install is gated by tier.
- Actual negotiated volume prices at 100/250/500 (all vendors: contact sales).
- Whether the tablet app's service-worker/TWA behaves identically under Hexnode's kiosk launcher vs Android lock-task mode — test in trial.
- Miradore Free plan's exact feature list beyond what its plan table shows (AE fully-managed enrolment and APK deploy are not marked Premium-only, so assumed included). Verify in the 14-day trial before enrolling the first 10.
- Whether any of Miradore/AirDroid/Scalefusion/Esper support Fire OS at all (none say so).
- AirDroid "Standard" per-device minimum for billing (none stated).

## Sources
- Hexnode developers/API — https://www.hexnode.com/mobile-device-management/developers/ ; plans — https://www.hexnode.com/mobile-device-management/help/what-are-the-pricing-plans-of-hexnode/ ; zero-touch — https://www.hexnode.com/mobile-device-management/help/zero-touch-enrollment/
- Esper API — https://api.esper.io/openapi ; zero-touch — https://help.esper.io/hc/en-us/articles/12624188351121-Zero-touch-Enrollment-ZTE-Provisioning
- Scalefusion API — https://help.scalefusion.com/docs/scalefusion-developer-api ; webhooks — https://help.scalefusion.com/docs/webhooks
- Miradore API v2 — https://www.miradore.com/knowledge/integrations/miradore-api-v2/
- Google Android Management API permissible usage (first-party in-house use prohibited; 500-device initial quota) — https://developers.google.com/android/management/permissible-usage
- Miradore plans & pricing — https://www.miradore.com/plans-pricing/ ; Android app management — https://www.miradore.com/knowledge/android/application-management/ ; QR fully-managed enrolment — https://www.miradore.com/knowledge/android/enroll-android-device-in-fully-managed-device-mode-using-qr-code/
- AirDroid Business plans — https://www.airdroid.com/wiki/understanding-airdroid-business-plans-pricing/ ; kiosk guide — https://www.airdroid.com/kiosk-mode/airdroid-business-kiosk-mode-guide/
- Hexnode pricing — https://www.hexnode.com/mobile-device-management/pricing/ ; Fire OS — https://www.hexnode.com/mobile-device-management/help/fire-os/ ; silent install — https://www.hexnode.com/mobile-device-management/help/how-to-silently-install-applications-on-android-devices-using-hexnode-uem/
- Esper pricing — https://www.esper.io/pricing ; Scalefusion pricing — https://scalefusion.com/pricing ; ManageEngine MDM Plus pricing — https://www.manageengine.com/mobile-device-management/pricing.html ; SureMDM pricing — https://www.42gears.com/pricing/mobile-device-management/ ; Headwind pricing — https://h-mdm.com/pricing/ ; Knox Suite Essentials — https://www.samsung.com/us/business/software/knox/knox-suite-essentials-plan-1-year-sku-mi-kxkmswwc210/ ; Fully Kiosk — https://www.fully-kiosk.com/
- Google Workspace mobile management editions — https://knowledge.workspace.google.com/admin/devices/compare-mobile-management-features
- Zero-touch requires an enterprise reseller — https://support.google.com/work/android/answer/7514005 ; provisioning methods need a factory-reset device — https://developers.google.com/android/management/provision-device
- Chrome `NotificationsAllowedForUrls` (Android from 142) — https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/ContentSettings/NotificationsAllowedForUrls.yaml
