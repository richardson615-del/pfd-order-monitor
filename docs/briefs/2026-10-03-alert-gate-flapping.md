# Workstream AG: alert gate re-appears on a working tablet (2026-10-03)

**Status (2026-10-03):** AG1, AG2, AG3 shipped in one bridge PR (see QUEUE row 13). Migration 047. The CRM does not yet display `alert_reason` / `alert_raised_at` / `alert_raised_reason` — that is a prs-crm row; the fields are in the roster and documented in `docs/crm-bridge-contract.md`. The "On the tablet now" steps below are still Nick's to do at Willie Mae's.

**Reported (Nick, 2026-10-03):** Willie Mae's, new Galaxy Tab A11, unmanaged (no Hexnode). The APK was installed from /install.html and the tablet was linked by code. Nick tapped Turn on alerts and allowed notifications. The full-screen "Turn on order alerts" gate keeps coming back.

## FACTS (read from code at main 39533a2)

- `components/useAlertGate.ts` `check()` runs on mount and on every `visibilitychange`, including screen on/off and returning from another app.
- When `Notification.permission === "granted"`, `check()` calls `subscribeAndRecord()`: `navigator.serviceWorker.ready`, then `getSubscription()`, then POST `/api/push/subscribe`.
- If that throws, it falls back to `hasSubscription`. But `hasSubscription` is set to `null` whenever reading it threw, and `if (hasSubscription)` treats `null` the same as `false`. So **any transient failure on wake** (a network blip on the POST, the service worker not ready yet, an RLS/500 from the route) sets the state to **"ask"** and shows the gate. That is the "random" revert.
- `alertGateState()` maps `permission === "default"` to "ask". Inside a TWA, `Notification.permission` follows the **Android app's** notification permission (Android 13+ POST_NOTIFICATIONS, declared in the manifest). A Samsung tablet whose **default browser is Samsung Internet** runs the TWA on Samsung Internet, where this delegation is unreliable.
- `android/twa-manifest.json`: `fallbackType: "webview"`, `enableNotifications: true`.
- The CRM Tablets page shows an unassigned self-registered device that checked in at install time with UA `SamsungBrowser/30.0 … Android 10; K`. **ASSUMPTION:** this is the Willie Mae's tablet opening the site in Samsung Internet, i.e. Samsung Internet is its default browser and possibly the TWA host.

## UNKNOWN

- Which provider hosts the TWA on this tablet (Chrome or Samsung Internet). Check: the `user_agent` on Willie Mae's most recent heartbeat row (`app/api/dashboard/heartbeat/route.ts` writes it).
- What `alert_state` the heartbeats recorded around each revert ("ask" vs "blocked" vs "unsupported").

## Packages

**AG1: stop transient failures from raising the gate (code, this repo)**
- In `check()`, keep three states for the subscription: present, absent, or **unknown** (the read threw). Raise "ask" only when the permission is not granted, or when it is granted and the subscription is **known absent** and a fresh `subscribe()` also fails.
- When the record POST fails but a browser subscription exists (or its state is unknown), stay "hidden". Report `pushSubscribed:false` on the heartbeat so the office still sees it, and retry the record on the next heartbeat.
- Debounce: only raise the gate after **two consecutive** failing checks at least 30 s apart. Never raise it on the first read after `visibilitychange` if the previous state was "hidden".
- Tests in `scripts/test-alert-gate.ts`: (a) granted + read throws + POST fails, previously hidden → stays hidden; (b) granted + known no subscription + subscribe fails twice → ask; (c) default → ask; (d) denied → blocked.
- **Done means:** on a tablet with alerts on, switching apps and turning the screen off and on 20 times never shows the gate. The heartbeat still reports a failed record.

**AG2: log why the gate went up**
- When the gate state changes from hidden to anything else, send `alertState` plus a reason code (`perm_default`, `perm_denied`, `sub_absent`, `sub_read_failed`, `record_failed`) and the user agent on the next heartbeat. Add a `alert_reason` column in the next sequential migration.
- **Done means:** the CRM can show, per tablet, the last time the gate went up and why.

**AG3: unmanaged-tablet setup check**
- In the app's "Turn on alerts" path, if the user agent shows the TWA is running on Samsung Internet or in a WebView, show one line telling staff to set Chrome as the default browser and reopen Premium.
- **Done means:** an unmanaged Samsung tablet tells staff which browser to fix, instead of looping the gate.

## On the tablet now (not code)
1. Settings → Apps → Choose default apps → Browser app → **Chrome**. Update Chrome from the Play Store.
2. Settings → Apps → Premium → Notifications → **Allowed**, with all categories on.
3. Settings → Battery → Background usage limits → add **Premium** and **Chrome** to **Never sleeping apps**.
4. Force-stop Premium and reopen it. If the gate still loops, uninstall and reinstall the APK, so it binds to Chrome.
