# Nick's systems map — read this first, whichever project you're in

This file sits above every repo in `C:\Users\richa\dev\`, so Claude Code loads it automatically in any of them. It tells you **what each project is, what you may touch, and how changes ship.** Each repo's own `CLAUDE.md` / `README.md` is the authority for that repo; this file only routes you and fills the gaps between repos. If they disagree, the repo file wins — say so.

Owner: Nick Davies, COO, Premium Restaurant Solutions / Premium Food Delivery (PFD). Nick makes the decisions; there is no one else to ask for sign-off. PRs auto-merge on green CI (see §5a).

## 1. When Nick says … go to …

| Nick says | He means | Repo / folder |
|---|---|---|
| "the app", "the tablet app", "Order Monitor", "Premium Orders", "the kitchen tablet", "notifications", "the APK", "the logo" | The restaurant-facing Android tablet app (a Trusted Web Activity wrapping a Next.js site) and its backend — orders in, printers + tablets out | `pfd-order-monitor` |
| "the bridge", "the order monitor bridge", "printers", "print jobs", "Epson", "tablet logins", "the Zuppler webhook" | Same repo — its `/api/crm/*` and `/api/print/*` backend | `pfd-order-monitor` |
| "the CRM", "the website", "crm.pfdworks.com", "the dashboard", "dispatch", "trouble tickets", "Devices console", "Partners", "Daily brief", "payouts", "onboarding" | The internal staff web app | `prs-crm` (main clone) or `prs-crm-agent` / `prs-crm-scale` (parallel clones, see §4) |
| "the restaurant websites", "Zuppler sites", "the ordering site" | Zuppler-built and hosted; **not in any repo here** — nothing to change in code; it's a Zuppler ticket (Kate Chynret) | — |
| "the MDM", "Hexnode", "enrol tablets" | Vendor console, not code. Code side = CRM tablet sync (D2, live since 2026-09-16) | see `pfd-order-monitor/docs/mdm-plan.md` |
| "the Play Console", "the developer account" | Google Play org account `play@pfdworks.com` — PFD's own; the app is **not** on the Play Store, it's pushed by the MDM | — |

If the request is ambiguous between the app and the CRM, look at **who sees it**: restaurant staff on a tablet → `pfd-order-monitor`; PFD staff in a browser → `prs-crm`.

## 2. The two systems and how they connect

```
Zuppler (webhook / Gmail poll) ─▶ pfd-order-monitor (Supabase A) ─┬─▶ Epson printers (Server Direct Print, poll every 5 s)
                                                                  └─▶ Tablet app (Realtime + Web Push + chime)
prs-crm (Supabase B, Vercel) ──── HTTPS `/api/crm/*` (PRINTER_BRIDGE_URL + CRM_WRITE_KEY) ──▶ pfd-order-monitor
prs-crm ──── Hexnode API (HEXNODE_PORTAL + HEXNODE_API_KEY, every 10 min) ──▶ tablets inventory
```

- **Separate databases.** The CRM never reads the bridge's tables; it calls `/api/crm/*` through `prs-crm/src/lib/printer-bridge.ts`. The shared key is **`restaurants.crm_restaurant_id` == CRM `accounts.id`** — the bridge's own `restaurants.id` is a *different* uuid (it creates the row itself; migration 007 stores the CRM id beside it). Since 2026-09-17 every CRM-facing bridge route accepts either id (`lib/restaurant-ref.ts`), and responses carry the bridge's `id`. (This line used to say the ids were equal; that belief is what broke tablet bind/link for every restaurant.)
- **The contract** is `pfd-order-monitor/docs/crm-bridge-contract.md`. Never guess a bridge shape from the CRM side; read that doc or the route.
- **Cross-repo features = two PRs, bridge merged first.** Both repos are Nick's own clones; working across both is explicitly allowed (kickoff prompt `C:\Users\richa\dev\order-app-kickoff-prompt.md`).

| | `pfd-order-monitor` | `prs-crm` |
|---|---|---|
| What | Order intake, printing, tablet app, tablet logins, health alerts | CRM: sales, onboarding, dispatch, tickets, partners, devices, payouts |
| Prod | `https://pfd-order-monitor.vercel.app` (tablets open `/dashboard`) | `https://crm.pfdworks.com` |
| Stack | Next.js 14, React 18, hand-written CSS, Supabase (own project) | Next.js 15, React 19, Tailwind v4 + shadcn (base-nova), Supabase (dev `tlirownztfjfypmzzmhw` / prod `geryrtvatuwawlellhwq`) |
| Rules file | `README.md` (+ `docs/release-checklist.md`) | `CLAUDE.md` (long; binding) |
| Migrations | `db/migrations/NNN_*.sql`, idempotent, applied by `migrate.mjs` on deploy (direct apply allowed when Nick says so), listed in `lib/schema-check.ts` `REQUIRED_SCHEMA` | `migrations/NNNN_*.sql`, sequential, run on deploy; `migrations/seeds/` is **prod data** |
| Tests | `npm test` = `tsx scripts/test-*.ts` (pure, no DB) | `npm test` (vitest), `npm run typecheck`, `npm run lint` |
| Android shell | `android/` (Bubblewrap TWA `com.pfdworks.orders`, key at `C:\Users\richa\OneDrive\pfd-app-signing\`) — rebuild only for icon/name/startUrl/managed-config changes; Hexnode pushes it. Current: 1.3.0 / code 5 | — |
| Do not touch | ingest fate-sharing, `lib/canonical.ts` `orderDestinations()`, `orders.status` semantics, `lib/usernames.ts` domain, `/api/crm/*` shapes without a contract update | live dispatch tables, bridge shapes, Supabase Auth config, `.env*`, `migrations/seeds/*`, `.claude/settings.json` |

## 3. How changes ship (both repos)
branch → edit → tests green locally → commit → push → `gh pr create` → CI green → **auto-merge (squash)** → Vercel deploys `main` to production. Never push to `main`. Never run `vercel --prod*`. Never print `.env*` values (key names only). Nick needs no one's sign-off, including for migrations. Web changes reach every tablet automatically (deploy + idle-time reload); only Android shell changes need an APK, and Hexnode pushes those.

## 4. Clones on this machine
| Folder | Branch policy | Use |
|---|---|---|
| `prs-crm` | tracks `main`; feature branches off it | spare CRM clone — use only when the other two are busy |
| `prs-crm-agent` | a **second clone** of the same repo for a parallel Claude Code session | Devices / Tablets / MDM surfaces. One session per clone; never open two sessions in the same folder; rebase on `main` before starting new work |
| `prs-crm-scale` | a **third clone** of prs-crm, created 2026-09-16 when two sessions collided in `prs-crm` | tickets, onboarding, Go live, Daily brief, login-print. Same rules |
| `pfd-order-monitor` | tracks `main`; feature branches off it | app + bridge work — one session at a time |
| **Rule (2026-09-16, updated 2026-09-28):** before starting a Claude Code session in a clone, run `git status` — if the tree is dirty or the branch isn't `main`, another session owns this clone; use a different clone. In a **lane** folder (`C:\Users\richa\dev\lanes\<repo>-<name>`, §4a) the branch `lane/<name>` or a feature branch is normal: Nick opened you there, the lane is yours. |||
| `C:\Users\richa\GitHub\prs-crm` | spare, stale | don't use |

## 4a. Lanes — several projects at once (2026-09-28)
Nick runs one project per **lane**. `lane new <name>` (add `-Repo pfd-order-monitor` for the bridge) creates `C:\Users\richa\dev\lanes\<repo>-<name>`: a git worktree off the latest `origin/main` on its own branch `lane/<name>`, with `.env*` copied and `node_modules` shared with the main clone while the lockfile matches. It then opens a terminal there running `claude`. Tool: `lane` (= `C:\Users\richa\dev\tools\lanes\lane.cmd`, which runs `lane-core.ps1`). `lane list` shows every lane and clone with its branch, uncommitted files, ahead/behind, PR and port. The three clones in §4 keep working as before.

Rules for every session, in a lane or a clone:
1. **One session per folder.** Never edit files in another lane or clone.
2. **Migration numbers:** never pick one by looking at the migrations folder. When you create the file, run `powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/richa/dev/tools/lanes/lane-core.ps1 next-migration -Repo <prs-crm|pfd-order-monitor> -Reserve <your folder name>` and use exactly the number it prints. It checks `origin/main`, every GitHub branch from the last 30 days, every clone and lane on this PC (uncommitted files included) and live reservations.
3. **New QUEUE rows:** use the same tool with `next-row` instead of `next-migration`. Edit only your own rows; never renumber or reflow anyone else's.
4. **Owner** of a lane's queue rows = its folder name (e.g. `prs-crm-menu-agent`). "Work the queue" in a lane takes rows owned by that name, or the row Nick names.
5. **Dev server** in a lane: `npm run dev -- -p <port>` with the port from `lane list` (CRM 3101+, bridge 3201+), never the default.
6. **Before every push:** `git fetch origin && git rebase origin/main`. QUEUE.md merges with git's union driver on this PC, so rows other lanes appended survive the rebase; afterwards check that your own row isn't duplicated (keep the newer line). If your migration number was taken on main in the meantime, rename your file to a fresh `next-migration` number before pushing.
7. **Changing packages:** first run `lane.cmd install <lane name>` (it swaps the shared `node_modules` for the lane's own); never `npm install` into a shared `node_modules`.
8. Creating, syncing and removing lanes is Nick's — don't run `lane new`, `lane sync` or `lane remove` yourself.

## 5. What you can and cannot reach from Claude Code
- **Can:** both repos read/write; GitHub (`gh`) for PRs and `gh pr merge --auto --squash` on your own PR; Vercel CLI (never prod flags); dev Supabase via `.env.local` in the CRM clones; the bridge's own Supabase via `pfd-order-monitor/.env.local`; the Hexnode API via `HEXNODE_*` in `.env.local` (read-only unless the task says otherwise); `npm` scripts. Production data read-only and only when Nick asks — confirm which DB you're on first (`prs-crm/CLAUDE.md` tells you how).
- **Cannot:** the Hexnode console UI, Zuppler admin, Google Play Console, the restaurants' Wi-Fi/printers, Nick's Gmail, the physical tablet. When a task needs one of these, mark the queue item **STOP** and hand Nick the exact click-path instead of guessing.

## 5a. The work queue — how hand-offs happen without Nick
Each repo has `docs/briefs/QUEUE.md`. When Nick says **"Work the queue"** in a terminal, that session takes the top `open` item owned by its clone, marks it claimed, ships it as a PR, marks it `PR #n`, and takes the next — until the queue is empty for that clone or an item says **STOP** (needs Nick). Never take another clone's item. A session that finishes something not on the list adds a Done line.

**Merging (Nick's decision 2026-09-16):** PRs merge themselves via GitHub auto-merge — `gh pr merge --auto --squash <n>` on your own PR once CI is green. This replaces "Nick merges". If the command is denied or the repo has auto-merge off, STOP and say so; never merge any other way. Stacked PRs: base first, retarget the child to `main` after.

**Resuming after `/clear` or a fresh start (2026-09-17):** Nick may clear any terminal at any time; the conversation is disposable, the files are not. On "Work the queue" in a fresh session: (1) `git status` + `git branch --show-current` — a non-`main` branch with commits means an item is mid-flight; (2) read QUEUE.md — the item marked `claimed (<this clone>)` is yours, its **Progress** note says where it stopped; (3) continue from there, don't restart. To make that cheap: before any step longer than a few minutes (a migration, a rebuild, a long test run) update your queue item's Progress note in one line — "K2: migration + lib done, approval email next" — and commit it with the work. Never leave a claimed item with no Progress note for more than one PR's worth of work.

## 6. Where the plans live (read before starting related work)
| Brief | Repo | Covers |
|---|---|---|
| `docs/briefs/QUEUE.md` | both | **The live to-do list. Start here.** |
| `docs/briefs/2026-09-14-devices-redesign-and-login-print.md` | prs-crm | A: CRM design refresh; B: print tablet login to Epson |
| `docs/briefs/2026-09-14-premium-brand-dashboard-alerts.md` | pfd-order-monitor | C: "Premium" brand, tablet dashboard, always-on alerts, auto-update |
| `docs/briefs/2026-09-15-tablet-fleet-and-followups.md` | both | D: bridge tablet status, CRM tablet inventory + MDM sync, onboarding checklist, test hygiene |
| `docs/briefs/2026-09-15-scale-to-500.md` | both | E: one-click go-live, health→tickets, 500-tablet hardening, bulk intake |
| `docs/briefs/2026-09-15-ticket-lifecycle-alerts-brief-vendor-email.md` | prs-crm | F: ticket lifecycle, vendor email threads |
| `docs/briefs/2026-09-15-security-assessment.md` | prs-crm | G: security assessment + recurring controls |
| `docs/briefs/2026-09-16-daily-brief.md` | prs-crm | H: kill reminder cards, Daily brief tab (supersedes F's "card persists until resolved") |
| `docs/briefs/2026-09-16-kiosk-first-run-and-orders.md` | pfd-order-monitor | I: kiosk device binding, first run, two-state orders |
| `docs/briefs/2026-09-17-accept-countdown.md`, `docs/briefs/2026-09-17-another-one-alert.md` | pfd-order-monitor | I3/I4: Accept + countdown, "ANOTHER ONE!" alert |
| `docs/briefs/2026-09-18-orders-dashboard.md` | both | M: CRM orders API (M1, bridge) + Orders dashboard (M2, CRM) + actions (M3) |
| `docs/briefs/QUEUE.md` | pfd-order-monitor | The work queue — "Work the queue" takes the top open item |
| `docs/briefs/2026-09-16-kiosk-first-run-and-orders.md` | pfd-order-monitor | I: kiosk device binding (serial via Hexnode managed config), Orders / Completed / Past week |
| `docs/mdm-plan.md`, `docs/hexnode-call-prep.md`, `docs/kiosk.md` | pfd-order-monitor | MDM vendor decision (Hexnode), tablet choice, rollout checklist, kiosk binding |

Later briefs supersede earlier ones where they conflict; the newest date wins. When you finish a package, note it as done at the top of that brief and in QUEUE.md so the next session doesn't redo it.

## 7. Facts Nick has decided (don't re-ask)
- Fleet: ~100 tablets at launch, 500+ restaurants within a year. MDM = **Hexnode** (portal `premium.uem.hexnode.com`, policy `Premium #1`). Tablets must be Play-certified Android; Amazon Fire is out. Trial unit: Samsung SM-X133 (Galaxy Tab A9), serial R8YL42BJPSB, at Willie Mae's.
- A tablet is bound to its restaurant by **serial**: Hexnode App Configuration pushes `device_ref = %serialnumber%`; the CRM's Hexnode sync fills `tablets`; assigning the tablet to an account in the CRM is the only human step. No login screen at the store.
- Hexnode policy must carry: Required App (Premium), App Configuration `device_ref=%serialnumber%`, App Permission "Send push notifications = Allow" (without it the alert gate loops).
- Restaurants never download anything; updates are automatic (web) or Hexnode-pushed (shell).
- Tablet dashboard shows no order source (Zuppler etc.); notifications are mandatory, not a setting. Order flow is Orders / Completed / Past week — no Accept step.
- Dispatchers get **one** Daily brief, not per-ticket reminder cards.
- Brand on the tablet app is **Premium**; "PFD" is internal only.
- Realtime is opt-in; the poll carries orders (Supabase Pro connection ceiling).
- Never fabricate data or status: unknown = "Data missing".
- Rotate the Hexnode API key before the first fleet ships (it was exposed in a transcript on 2026-09-16; Nick accepted the interim risk).
