# Claude Code instruction package — Workstream GL: Go-live readiness test (all facets)

Author: Nick (as CTO, via Claude) · For: **Matt** (run in your Claude Code) · Date: 2026-11-01
Repos: `prs-crm` (main work) + `pfd-order-monitor` (bridge/tablet checks) · Workstream code: **GL**
Repo rules (`prs-crm/CLAUDE.md`, `pfd-order-monitor/README.md`, `C:\Users\richa\dev\CLAUDE.md`) win over this brief. On any conflict, stop and say so.

## Intent
> Run a test that proves we can go live with real users and in the live marketplace across every facet of the business. (Nick, 2026-11-01)

Output is **evidence, not opinion**: a go/no-go scorecard where every row is PASS / FAIL / BLOCKED with a link to the test run, log or screenshot that proves it. Nothing is marked PASS from reading code alone.

## What "go live" means here (scope)
| # | Facet | Live path being proven |
|---|---|---|
| F1 | Customer ordering | PFD Ordering (own checkout, replacing Zuppler — B1–B4) on restaurant sites + app; Zuppler path still works in parallel |
| F2 | Phone orders | CRM `/orders/new` → Helcim charge → kitchen → dispatch |
| F3 | Marketplace orders | Uber Eats (sandbox built UE1–UE3), ezCater (live), DoorDash/Grubhub/Toast/Square/Clover where credentials exist; KitchenHub as fallback |
| F4 | Chain orders | chain-placer bot (BK pilot) from the bot PC |
| F5 | Kitchen delivery | bridge → tablet app (alerts, Accept, Store pause) + Epson + Email-to-PC + Eatabit (via Zuppler) |
| F6 | Dispatch & drivers | own dispatch board (shadow → live), driver app (proof photo, route), Uber Direct overflow, call-outs, shift forecast |
| F7 | Customer comms | Twilio SMS (status/tracking), receipts, Postmark email |
| F8 | Money | Helcim charge / refund / reverse, 4% card fee, tips split, restaurant payouts + statements, driver pay + Focus card, cash log |
| F9 | Staff ops | tickets, Pete, Daily brief, schedule, vendor email threads |
| F10 | Platform | Vercel, both Supabase projects, crons, monitoring, backups, rollback |
| F11 | Security | auth/roles, webhook signatures, no card data, rate limits, secrets |

## Ground truth
**FACT** (project state docs, dated):
- Volume ~4,500 orders/month; ~80 partner restaurants + ~69 chain locations; target 500+ restaurants within a year.
- Helcim live in CRM production since 2026-10-21 (`PAYMENTS_PROVIDER=helcim`). Limits: **$150,000/month, $1,500 per transaction.** Online + app + phone volume is ~$300–400K/month (2026-10-24 estimate).
- Uber Direct: production keys + webhook in Vercel (10-25). DoorDash Drive: "Pending activation". DoorDash Marketplace: applied 10-24, quarterly review. Toast: applied 10-25 (≤30 days). Uber Eats: sandbox only.
- Own dispatch is in **shadow mode** beside Shipday (decision 10-24).
- Tablets: fleet still mostly in the office; device alerts off until rollout done (10-16, 10-23). White House restaurants are the test run.
- Bridge Realtime is opt-in; the poll carries orders because of the Supabase Pro connection ceiling.
- CI is not a required check on `main`; duplicate migration numbers 0262/0264 exist (10-25).
- Nextiva numbers ported to Twilio (10-30). Twilio A2P 10DLC was a STOP for driver texts (DS4, 09-29).

**ASSUMPTION** (Nick's intent — confirm in GL0 if wrong):
- "Live marketplace" = customers ordering through PFD's own checkout and the third-party marketplaces, with own dispatch, at full current volume.
- Load target = **10× today's measured peak hour** (covers growth to ~500 restaurants with headroom). If GL0 can't measure the peak, use 150 orders/day average → 30/hr assumed peak → test 300/hr sustained, 900/hr 10-minute burst.

**UNKNOWN** (GL0 answers before anything else):
- Status of PFD Ordering B1–B4 (built? on which sites?).
- Real peak hour and peak day from order history.
- Driver app distribution (iOS TestFlight + Android?) and how many drivers have it.
- Twilio A2P 10DLC registration status.
- Supabase plan limits (connections, Realtime) for CRM prod and the bridge.
- Backups / point-in-time restore enabled on both Supabase projects.
- Whether a staging environment exists beyond Vercel previews + dev Supabase.

## Test rules (hard)
1. **No load or scenario tests against production databases.** Use Vercel preview deployments + dev Supabase (CRM `tlirownztfjfypmzzmhw`; bridge dev project if one exists — if not, GL1 creates one or STOPs).
2. **Real money only in GL6**, only on the test account "Premium Food Delivery (test)", max $1.00 per charge, reversed same day. Log every charge id.
3. Vendors in sandbox mode only (Uber Eats sandbox, Helcim test account, Uber Direct sandbox if available). Never trigger a real courier from a test.
4. No real customer or driver phone numbers / emails in test data — synthetic only. Test SMS go to staff numbers Nick/Matt list.
5. Never print `.env*` values. Never `vercel --prod`. Never push `main`. PR-only, squash auto-merge on green CI.
6. A test that can't run because a vendor/credential is missing = **BLOCKED** with the owner named, never skipped silently.

## Packages (one PR each unless noted)

### GL0 — Readiness probe (docs-only, read-only)
- Inventory every live path in the scope table: entry point, code path (file:line), external dependency, env var **names** present in Vercel prod/preview, and current status.
- Measure from data (read-only prod, Nick's standing permission for read-only probes): orders per hour/day for the last 60 days (or since 2026-09-02 if that's the limit), peak hour, peak day, average items/order, share by channel.
- Answer every UNKNOWN above.
- Output: `docs/research/2026-11-01-go-live-inventory.md`.
- Acceptance: every facet F1–F11 has a row; every UNKNOWN is answered or marked BLOCKED with an owner.

### GL1 — Test harness + synthetic data
- `scripts/golive/` (prs-crm): seeds a **synthetic market** into dev Supabase — 100 restaurants (copied menu shapes from real menus, fake names), 40 drivers, 2,000 customers, realistic addresses inside the Springfield/White House service area, deal terms covering every revenue stream (pickup, delivery, phone, marketplace, catering, chain).
- Bridge counterpart in `pfd-order-monitor` (separate PR, **merged first**): seed matching restaurants + simulated tablets/printers (no physical device needed — a virtual Epson poller that records what would print).
- One command runs everything and writes results to `docs/research/golive-runs/<timestamp>.md`.
- Acceptance: seed is idempotent; teardown leaves zero rows; nothing touches prod.

### GL2 — End-to-end scenario suite (functional)
One automated scenario per row; each asserts the order reaches every system it should, with correct money, within time limits.

| ID | Scenario | Must prove |
|---|---|---|
| S1 | Web pickup order, PFD checkout, card | Menu → cart → Helcim (test) charge incl. 4% card fee → tablet alert + print ≤ 30 s → restaurant payout line correct |
| S2 | Web delivery order | S1 + appears on own dispatch board → assigned → driver app pickup/drop + proof photo → customer SMS at each status → driver pay line (base + mileage + 100% tip) |
| S3 | Zuppler order (parallel path) | Order Workflow → bridge → tablet; CRM Orders shows it; payout correct |
| S4 | Phone order, new + saved card | `/orders/new` → Helcim → kitchen → dispatch; saved card reused on 2nd call |
| S5 | Uber Eats sandbox order | Webhook in → kitchen → Accept sent back inside window; **auto-accept** fires if nobody taps; cancel from Uber cancels kitchen ticket |
| S6 | ezCater catering (scheduled) | Arrives, scheduled correctly, paid as "catering orders" adjustment |
| S7 | Chain order | Placement queued → bot dry-run (no Pay click in test) → dispatch |
| S8 | Overflow | No driver available → Uber Direct quote (sandbox) → handoff recorded |
| S9 | Refunds | Full refund, partial refund, same-day reverse; payout + statement reflect it; cancelled order never paid |
| S10 | Store pause | Tablet Store tab pause → web ordering closed → marketplace store off (where API exists) → resume restores |
| S11 | Payout week | Close a synthetic week → statements generate → totals reconcile to orders to the cent |
| S12 | Driver settle | Cash log + settle screen + Focus card load file reconcile to driver pay engine (1¢ tolerance) |
| S13 | Tickets + Pete | A failed print / late order raises a ticket; Pete posts; Daily brief counts it |

- Acceptance: every scenario PASS twice in a row on a fresh seed, or BLOCKED with owner.

### GL3 — Load + peak test
- Drive the ASSUMPTION load (or the GL0-measured 10× peak) against a **preview deployment + dev databases**: sustained 60 minutes, then a 10-minute burst at 3×.
- Mix by channel from GL0's measured shares.
- Measure: order ingest → tablet visible (p50/p95/p99), print-job pickup latency, checkout API latency, dispatch board refresh, webhook 2xx rate, cron overrun, Supabase connections in use vs limit, Vercel function errors/timeouts, duplicate orders.
- **Pass gates (proposed, Nick can change):** 0 lost orders, 0 duplicate orders, 0 double charges; p95 order-to-tablet ≤ 30 s; p99 ≤ 60 s; error rate < 0.5%; DB connections < 70% of limit; no cron overrun.
- Output: numbers + where it broke + the fix list (each fix = its own follow-up QUEUE row, not built inside GL3).

### GL4 — Failure drills
Prove the business keeps taking orders when something breaks. Each drill: inject → observe → recover → confirm no lost/duplicate orders.
| Drill | Inject | Expected |
|---|---|---|
| D1 | Helcim down / declines | Clear decline message, order not sent to kitchen, retry works, no double charge |
| D2 | Webhook replayed 3× (Zuppler, Uber Eats, Helcim) | Stored once (idempotent) |
| D3 | Bridge unreachable from CRM for 5 min | Orders queue and deliver after; ticket raised |
| D4 | Tablet offline | Printer still prints; alert/ticket after threshold |
| D5 | Driver no-show / call-out mid-shift | Order reassigned; overflow offered |
| D6 | Twilio failure | Order flow unaffected; failure logged |
| D7 | Bad deploy | Vercel instant rollback to previous deployment works in < 5 min (document the click-path) |
| D8 | DB restore | Restore a dev backup to a point in time (proves the prod procedure) |

### GL5 — Money + security integrity
- Reconciliation script: for a test day, every order's customer charge = restaurant payout + PFD revenue + driver pay + processor fee + tax, to the cent. Any variance listed by order.
- Helcim **limit check**: project the go-live monthly card volume vs the $150K/month and $1,500/txn limits — report as a go-live blocker if over (it is, per the 10-24 estimate, unless the limit is raised).
- Surcharge check: 4% card fee vs Visa 3% cap / no debit surcharge — report status only (Nick's open Q4); no code change.
- Security: confirm every webhook verifies its signature, no card numbers/PAN anywhere in DB or logs (grep + DB scan), role checks on page + API share one predicate, rate limits on public checkout + `/drive`, secrets not in repo. Reuse the nightly security loop's findings; don't duplicate it.

### GL6 — Live pilot (controlled, real world) — **STOP: needs Nick's go**
- 2–3 White House restaurants with tablets in place + staff as customers.
- Real orders through each channel available (web, phone, Uber Eats if production-approved), real drivers on own dispatch **with Shipday still running in parallel** as the safety net.
- Real money capped at $1.00 test charges on the test account, reversed same day, except staff-paid real meals if Nick approves.
- Daily check: every pilot order matched across CRM, bridge, dispatch, Helcim, payouts. 3 clean days = pass.

### GL7 — Go/no-go scorecard (docs-only)
- `docs/research/2026-11-xx-go-live-scorecard.md` + update the Open Projects board.
- One row per facet F1–F11: PASS / FAIL / BLOCKED, evidence link, owner, fix row.
- Separate list: **non-code blockers** (vendor approvals, credentials, limits, hardware).
- Recommendation: GO / GO with conditions / NO-GO, and the cutover order (which channel first).

## Known go-live blockers to carry into the scorecard (FACT, not for GL to fix)
| Blocker | Owner |
|---|---|
| Helcim $150K/month limit vs ~$300–400K/month volume | Nick/Matt → Helcim Credit Risk |
| DoorDash Marketplace + Drive not approved; Grubhub needs a kickoff call; Toast pending | DoorDash / Grubhub / Toast (KitchenHub fallback) |
| Uber Eats production access (sandbox only) | Matt → Uber |
| Saved cards don't carry across processors (Zuppler → PFD checkout) | Nick (internal decision) |
| Tablets not deployed beyond the White House test | Grant/Elijah + Forrest |
| CI not required on `main`; duplicate migrations 0262/0264 | Nick (GitHub setting) |
| Twilio A2P 10DLC (if still unregistered) | Matt |
| 4% surcharge vs card-brand rules | Nick |

## Order of work
GL0 → GL1 (bridge PR first, then CRM) → GL2 + GL5 in parallel lanes → GL3 → GL4 → GL7 draft → **STOP** for Nick → GL6 → GL7 final.
Take QUEUE row numbers from `lane next-row`; migrations (if any) from `lane next-migration`. Update the item's Progress note before any long step.

## Open questions for Nick (defaults let Claude Code proceed unattended)
1. Load target? **Default: 10× measured peak hour; 3× burst for 10 min.**
2. Pass gate for order-to-tablet latency? **Default: p95 ≤ 30 s, p99 ≤ 60 s.**
3. Pilot restaurants for GL6? **Default: the White House restaurants that already have a tablet in place (from Forrest's list), max 3.**
4. Keep Shipday running during the pilot? **Default: yes, in parallel until GL7 says GO.**
5. Real staff-paid orders in the pilot? **Default: no — $1.00 test charges only.**

## Delivery
PR-only, rebase on `origin/main`, green CI, `gh pr merge --auto --squash`. Never push `main`, never `vercel --prod*`, never print `.env*`. `migrations/seeds/` is prod data — GL never writes there. Every PR body: "Brief: docs/briefs/2026-11-01-go-live-readiness-test.md".
