# Work queue — pfd-order-monitor

Claude Code: when Nick says **"Work the queue"**, take the top `open` item, set Status to `claimed (<date>)`, commit that one-line change on your branch, do the work as its own PR, set Status to `PR #n`, take the next. Stop at an item marked **STOP** — it needs Nick. Read the brief first; the brief wins if this file is stale. Only one Claude Code session works this repo at a time.

**Merging (Nick's decision 2026-09-16): PRs merge themselves.** After CI is green, run `gh pr merge --auto --squash <n>` on your own PR. If that command is denied or auto-merge is off for the repo, STOP and tell Nick — do not merge any other way. Stacked PRs: enable auto-merge on the base first; retarget the child to `main` after the base merges. Cross-repo features: this repo's PR merges before the CRM's.

| # | Item | Brief | Status |
|---|---|---|---|
| 0 | Enable auto-merge on the open PRs in this order: #62, then #63 (retarget base to main after #62 merges), then #64 | — | done 2026-09-16 — #62, #63, #64 merged (and #65, #66). Repo auto-merge is now ON |
| 1 | E3 follow-up `feat/poll-first`: Realtime opt-in (env flag, default off), incremental poll "changed since last sync" | docs/scale-500.md §6 | PR #65 — merged 2026-09-16 |
| 2 | C4 leftovers: `MIN_SHELL_VERSION` gate + `/api/version` idle-reload verified on 1.3.0 — **STOP before setting MIN_SHELL_VERSION=5 in Vercel; Nick confirms fleet is on 1.3.0** | docs/briefs/2026-09-14-premium-brand-dashboard-alerts.md | **STOP 2026-09-16 — handed to Nick.** Code side verified on main (startUrl `?shell=5`, `/api/version` + heartbeat carry `minShellVersion`, amber line + idle reload tested). Nick: confirm every unit shows 1.3.0 in Hexnode / shell 5 on CRM Tablets, then set `MIN_SHELL_VERSION=5` in Vercel (production) and redeploy |
| 3 | Kiosk acceptance script: `scripts/test-kiosk-flow.ts` covering bootstrap bound/unbound/throttled, link code, unseen(), buckets, per-day aggregation in America/Chicago | docs/briefs/2026-09-16-kiosk-first-run-and-orders.md | PR #67 |
| 4 | Ready screen "Send me a test order" wired to `/api/dashboard/test-order`; auto-advance 20 s | same | done — shipped in #61 (I1): `ReadyScreen.tsx` posts to `/api/dashboard/test-order`, `READY_AUTO_ADVANCE_MS = 20_000`; pinned by `scripts/test-first-run.ts` and `test-kiosk-flow.ts` |
| 5 | D3b test hygiene (whatever is still open) | docs/briefs/2026-09-15-tablet-fleet-and-followups.md | done — nothing open: prs-crm #50 (Node 24 in engines + CI), #56 (two timeouts + the stranding teardown), #72 (integration suite in CI on postgres:17, TEST_DB_ALLOWLIST), #117 (CI builds the app); latest merged PR #160 green |
| 6 | Pre-launch load test against a dev deployment — **STOP: needs Nick to create the dev deployment + a tablet login** | docs/scale-500.md | open — STOP (Nick) |
| 7 | Rotate Hexnode API key + update Vercel — **STOP: Nick does this in Hexnode Admin → API before first fleet ship** | — | open — STOP (Nick) |
| 8 | PR #48 (2026-09-15): Gmail poll shared-secret check fails open when `CRON_SECRET` is unset and compares with `!==` — rebase on main, CI, merge | PR #48 body | claimed (2026-09-16) |

Done today (2026-09-16): #60 I2, #61 I1, #62 alert copy, #63 D1, #64 stale-print, #65 poll-first, #66 queue file — all merged; production build 515565f, migrations 037–039 applied. This file replaces docs/work-queue.md. APK 1.3.0 (code 5) uploaded to Hexnode; policy Premium #1 v6 has device_ref=%serialnumber% and notifications=Allow.
