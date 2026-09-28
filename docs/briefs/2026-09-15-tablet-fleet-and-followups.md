> **Status 2026-09-16:** D1 done — #53 (roster tablet object, timezone, latest_shell_version) + #62 (`alert_state`, migration 037) + #63 (`GET /api/crm/restaurants/:id`, `device_ref` on the tablet object, `tablet`+`timezone` on every issue). D2 done — prs-crm 0087–0090 + #156 (link/bind) + #157 ("Alerts blocked" label) + #159 (Hexnode live, real syncs against dev). D3a/D3b: not checked this session.

# Claude Code instruction package — Workstream D: tablet fleet in the CRM + follow-ups

Three independent packages. D1 runs in `pfd-order-monitor`; D2 and D3 run in `prs-crm`. D2 depends on D1 being merged (bridge-first rule in `prs-crm/CLAUDE.md`). D3 has no dependencies and can start now. Obey each repo's `CLAUDE.md`/`README.md`; where this brief disagrees, the repo rules win — stop and say so.

Author: Nick Davies. Date: 2026-09-15. Companion briefs: `prs-crm/docs/briefs/2026-09-14-devices-redesign-and-login-print.md` (A/B), `pfd-order-monitor/docs/briefs/2026-09-14-premium-brand-dashboard-alerts.md` (C), `pfd-order-monitor/docs/mdm-plan.md` (MDM decision).

Label key: FACT = read from code on 2026-09-14/15. ASSUMPTION = Nick's intent as interpreted. UNKNOWN = probe before building.

---

## Why
PFD is moving to company-owned, MDM-managed kitchen tablets (shelf stock, attrition replacement). Today the CRM Devices console knows about **printers** (bridge devices) but a tablet is only a per-restaurant `app_expected` flag — FACT. Dispatch needs to see, per restaurant, whether the tablet is open, hearing alerts, on the current shell, and which physical unit (serial) is there. The bridge already records most of this; nothing exposes it to the CRM.

---

## D1 — Bridge: expose tablet status + restaurant timezone (`pfd-order-monitor`, PR `feat/crm-tablet-status`)

### Facts
- `dashboard_heartbeats` (migration 024): one row per restaurant, `last_seen_at`, `user_agent`. Heartbeat `POST /api/dashboard/heartbeat` every 2 min from the dashboard.
- `push_subscriptions`: rows per browser endpoint; health rule `restaurant_no_app_device` when zero for an `app_expected` restaurant. `tablet_not_watching` critical when heartbeat ≥15 min old and an order arrived in the last 30 min (`lib/health.ts`).
- `GET /api/crm/restaurants` returns `RestaurantBranding` fields (see `docs/crm-bridge-contract.md`); no heartbeat/push/timezone fields today.
- Workstream C4 adds `push_subscribed` and `shell_version` to the heartbeat body/table (migration 031) and `GET /api/version`. If C4 is not merged yet, D1 adds those columns itself (idempotent, add to `REQUIRED_SCHEMA`) and C4 reuses them — coordinate by checking `db/migrations/` before numbering.
- UNKNOWN: whether `restaurants` has a `timezone` column. Check `db/schema.sql` + migrations first.

### Build
1. Migration `03x_restaurant_timezone.sql` (only if missing): `restaurants.timezone text not null default 'America/Chicago'`, CHECK it is a valid IANA name is not enforceable in SQL — validate in the API. Add to `REQUIRED_SCHEMA`.
2. Extend `GET /api/crm/restaurants` rows with a `tablet` object (all nullable, never fabricated):
   ```json
   "tablet": {
     "expected": true,                  // = app_expected
     "last_seen_at": "…|null",          // dashboard_heartbeats.last_seen_at
     "online": true,                    // server-computed: last_seen_at within 5 min (constant, exported, tested)
     "push_subscribed": true|null,      // latest heartbeat's push_subscribed (null if column/row missing)
     "push_subscriptions": 2,           // count(push_subscriptions) for restaurant
     "shell_version": 3|null,           // latest heartbeat's shell_version
     "display_mode": "kitchen|standard",
     "user_agent": "…|null"
   },
   "timezone": "America/Chicago"
   ```
   Also add `"latest_shell_version": <int from env MIN_SHELL_VERSION or null>` at the top level of the list response so the CRM can flag out-of-date shells without hardcoding.
3. Accept `timezone` in `POST /api/crm/restaurants/:id` (patch); reject non-IANA names with 400 `invalid_timezone` (validate with `Intl.DateTimeFormat`).
4. The tablet dashboard clock (`components/OrderDashboard.tsx`) uses `restaurants.timezone` when set — one-line change; C2 may already do this.
5. Update `docs/crm-bridge-contract.md` with the new fields (this doc is the contract the CRM must not guess).
6. Tests (`scripts/test-*.ts`, pure, added to `npm test`): `tabletOnline(lastSeenAt, now)` boundary; response shape has `tablet` with nulls when heartbeat row missing; `invalid_timezone` path.

Acceptance: `npx tsc --noEmit` + `npm test` green; contract doc updated; `GET /api/crm/restaurants` in dev returns `tablet` for every row with `null`s where no data.

---

## D2 — CRM: tablet inventory + fleet status in the Devices console (`prs-crm`, PR `feat/tablet-fleet`)

### Facts
- The CRM stores no device data; printers come from the bridge via `src/lib/printer-bridge.ts`. Devices console is `/devices` (A2 rebuilds it as a restaurant table + devices table). Access: `assertCanManagePrinters` = admin|dispatcher|tech.
- Nick's tablet programme: PFD buys tablets, keeps shelf stock, replaces on failure, enrols via MDM (vendor leaning Hexnode — not signed), QR enrolment for reset units and zero-touch for bulk-bought units.
- Scale (Nick, 2026-09-15): the fleet will exceed 50 tablets soon and the goal is **500+ restaurants within a year**. Manual serial entry does not scale, so D2 **syncs inventory from the MDM's REST API**. Vendor leaning: Hexnode UEM (see `pfd-order-monitor/docs/mdm-plan.md`); not signed yet — build behind a vendor-agnostic adapter.
- No MDM vendor emits online/offline webhooks (verified 2026-09-15) → poll.

### Build
1. Migration `00xx_tablets.sql` (check highest number on `main`):
   ```sql
   create table tablets (
     id uuid primary key default gen_random_uuid(),
     serial text not null unique,
     model text,                       -- e.g. "Samsung Galaxy Tab A9"
     asset_tag text unique,            -- PFD label
     status text not null check (status in ('stock','assigned','in_repair','retired')) default 'stock',
     account_id uuid references accounts(id),   -- null while in stock
     mdm_device_id text,               -- id shown in the MDM console
     enrolled_at timestamptz,
     assigned_at timestamptz,
     retired_at timestamptz,
     notes text,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   );
   create index on tablets(account_id);
   ```
   Add a `tablet_events` audit table (tablet_id, action `received|enrolled|assigned|unassigned|repair|retired|note`, actor_user_id, note, created_at). No seed rows.
1b. **MDM adapter** `src/lib/mdm/provider.ts`: interface `MdmProvider { listDevices(): Promise<MdmDevice[]>; getDevice(id): Promise<MdmDevice|null>; reboot(id): Promise<void>; enrolmentInfo?(): … }` with `MdmDevice { id, serial, model, os_version, last_seen_at, installed_app_version (for com.pfdworks.orders) | null, kiosk_locked: boolean|null, wifi_ssid|null, battery|null, group|null }`. Implement `hexnode-provider.ts` first (env `MDM_PROVIDER=hexnode`, `HEXNODE_PORTAL`, `HEXNODE_API_KEY`) and a `mock-provider.ts` for tests/dev; add `esper-provider.ts` only if Nick picks Esper. Same swappable-provider pattern the repo already uses for email/SMS. Never call the vendor from a route directly.
1c. **Sync job**: `GET /api/cron/mdm-sync` (Vercel cron, every 10 min, `CRON_SECRET`-guarded like existing crons — check `vercel.json`): upsert `tablets` by serial from `listDevices()` (creates rows with `status='stock'` for unknown serials, updates `mdm_device_id`, `model`, `mdm_last_seen_at`, `shell_version_mdm`, `kiosk_locked`), never touches `account_id`/`status` for existing rows, and writes one `tablet_events` row per material change. Store the raw vendor payload in `tablets.mdm_raw jsonb` for debugging. Rate-limit friendly: one list call per run; page if the API pages. Add columns `mdm_last_seen_at timestamptz`, `shell_version_mdm int`, `kiosk_locked boolean`, `mdm_raw jsonb`, `mdm_synced_at timestamptz` to the `tablets` migration above.
1d. **Assignment auto-suggest**: if the MDM device name/group encodes a restaurant (Nick's naming rule in the MDM: `<asset tag> · <restaurant name>`), the sync proposes an assignment (`tablets.suggested_account_id`) that a dispatcher confirms — never auto-assigns.
2. `src/lib/tablets.ts`: list/create/update/assign/unassign/retire, each writing a `tablet_events` row; domain errors as `class TabletError extends Error` mapped in `api-errors.ts`. Rule: an account can have at most one `assigned` tablet unless `allow_multiple` is passed (some stores run two) — enforce in lib, not DB.
3. Routes (thin, zod, `requireSession` → `assertCanManagePrinters`): `GET/POST /api/tablets`, `PATCH /api/tablets/[id]`, `POST /api/tablets/[id]/assign` `{accountId}`, `POST /api/tablets/[id]/unassign` `{reason}`, `POST /api/tablets/[id]/reboot` (→ `MdmProvider.reboot`, audited), `POST /api/admin/mdm-sync` (admin-only manual trigger). Manual `POST /api/tablets` stays as the fallback for units the MDM hasn't reported yet.
4. `printer-bridge.ts`: extend `RestaurantBranding` with the D1 `tablet` object and `timezone`; add `latest_shell_version` to the list result type. Relay only — never compute `online` in the CRM.
5. UI, in the A2 restaurant table (or the current `OrderDestinationsList` if A2 is not merged yet — check):
   - **Tablet column**: dot + label from bridge data: Live (online), Quiet (expected, last seen >5 min), Alerts off (`push_subscribed=false` or `push_subscriptions=0`), Not set up (expected, never seen), Off (not expected). Shell chip "v3" turns amber when `< latest_shell_version`.
   - **Unit**: assigned tablet's serial/asset tag, or "— assign" link.
   - Header meta adds: tablets live / expected, alerts off count, out-of-date shells count, stock count, last MDM sync time (red if >30 min).
   - **Two liveness sources, shown distinctly**: bridge heartbeat = "app open & talking to us" (primary, 2-min); MDM last-seen = "device reachable by the MDM". A tablet that is MDM-online but bridge-quiet means the app is closed/crashed → label "App not running" with a **Reboot** action.
6. New page `/devices/tablets`: inventory table (serial, model, asset tag, status, restaurant, MDM last seen, shell version, kiosk locked, last event) with filters by status and search by serial/restaurant, paginated (500+ rows), CSV export; "Add tablet" (serial, model, asset tag, MDM id); row actions Assign (account search — reuse `ReassignPicker` pattern), Unassign, Mark in repair, Retire, Note. Nav: sub-link under Devices for the same roles.
7. Partner page (`/partners/[id]`, RRM): add a "Tablet" fact block — unit, status, last seen, alerts, shell — read-only.
8. Tests: unit tests for status-label derivation (pure function, all states incl. "App not running"), assign/unassign rules, sync upsert logic against `mock-provider` (new serial → stock row; known serial → fields updated, assignment untouched; vendor error → run recorded as failed, nothing written), route 403 for `caller`. Migration test parity as the repo requires.

Acceptance: no bridge or MDM shape guessed (bridge fields from the contract doc; Hexnode fields from https://www.hexnode.com/mobile-device-management/developers/ — probe the real API with a read-only key before mapping); a full sync of the trial portal populates `/devices/tablets`; CI green; screenshots of `/devices` with tablet column and `/devices/tablets`; migration reviewed by Nick before merge (repo rule: ping before merging anything with a migration — Nick has since said self-merge is fine, but record it in the PR body).

---

## D3 — CRM: managed-tablet onboarding checklist + test-debt cleanup (`prs-crm`, two small PRs)

### D3a — Onboarding checklist for tablet provisioning (PR `feat/tablet-onboarding-tasks`)
Facts: onboarding checklist templates live in migrations (0048 added `testing_and_launch_23..26` for printer setup; 0050 added `27..32` for the app path). Launch gate items exist (0050 item #20; 0074 renamed one).
Build one migration adding templates under the existing app-path section (numbering after the current max — read the templates table first), each with detail text a dispatcher can follow:
1. "Pull a tablet from stock and record its serial against this restaurant in Devices → Tablets" (links to D2 page if merged; otherwise plain text).
2. "Enrol the tablet in the MDM with the Kitchen tablet QR (factory-reset first if not new)."
3. "Confirm Premium Orders installed and locked in kiosk; screen stays on while charging."
4. "Sign in with the restaurant's tablet login (print it to their printer from Devices if they have one)."
5. "Tap Turn on alerts; send a Test order from Devices; confirm chime + notification."
6. "Set the restaurant's timezone on the bridge record if not Central."
Gate: add/adjust a launch-gate item "Tablet live and alerts on (bridge shows Live + subscribed)" that reads the D1 `tablet` object when available, else stays manual. Don't hard-code the MDM vendor name anywhere in the templates (Nick hasn't picked one yet) — say "the MDM".

### D3b — Test debt (PR `chore/test-hygiene`)
Facts (from `CLAUDE.md`/prior sessions, verify first): three test files have non-idempotent teardowns that strand rows (tasks, send-email-route, objection-reasons); two failing tests on `main` at 5000 ms timeouts (objection-reasons "seven codes", agent-notify-route per-hour cap); CI runs typecheck+unit only with no `DATABASE_URL`, so integration tests never run in CI; `.github/workflows/ci.yml` pins Node 20 while Vercel runs Node 24 and `package.json` engines says `>=24`.
Build: fix the teardowns (truncate by test-run tag, `afterAll` guarded), fix or quarantine the two failing tests with a written reason, bump CI to Node 24, and add a CI job that runs integration tests against a `postgres:17` service with `DATABASE_URL` set and `TEST_DB_ALLOWLIST` satisfied. No product code changes. Report before/after test counts in the PR body.

---

## Delivery rules
- Branches as named; one PR each; CI green; squash-merge. Bridge (D1) before CRM (D2). D3a/D3b anytime.
- Never fabricate tablet status: every label maps to a bridge field or "Data missing".
- Never print `.env*` values; never push to `main`; never `vercel --prod*`.
- Migrations: sequential numbering checked against `main` at PR time; `prs-crm` seeds are prod data — no test rows in `migrations/seeds/`.

## Open questions for Nick (defaults in bold)
0. MDM vendor: **Hexnode** assumed for the first adapter. Say if you sign with Esper instead.
1. Can a restaurant have two tablets at once? **Allow, behind a flag** (`allow_multiple`).
2. Tablet "online" threshold for the CRM label: **5 minutes** (heartbeat is every 2 min) vs the health rule's 15 min.
3. Should dispatchers be able to add/assign tablets, or admin/tech only? **Same roles as printers (admin, dispatcher, tech).**
