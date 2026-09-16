# Work queue — pfd-order-monitor

Claude Code: when Nick says **"Work the queue"**, take the top `open` item, set Status to `claimed (<date>)`, commit that one-line change on your branch, do the work as its own PR, set Status to `PR #n`, take the next. Stop at an item marked **STOP** — it needs Nick. Read the brief first; the brief wins if this file is stale. Only one Claude Code session works this repo at a time.

**Merging (Nick's decision 2026-09-16): PRs merge themselves.** After CI is green, run `gh pr merge --auto --squash <n>` on your own PR. If that command is denied or auto-merge is off for the repo, STOP and tell Nick — do not merge any other way. Stacked PRs: enable auto-merge on the base first; retarget the child to `main` after the base merges. Cross-repo features: this repo's PR merges before the CRM's.

| # | Item | Brief | Status |
|---|---|---|---|
| 0 | Enable auto-merge on the open PRs in this order: #62, then #63 (retarget base to main after #62 merges), then #64 | — | open |
| 1 | E3 follow-up `feat/poll-first`: Realtime opt-in (env flag, default off), incremental poll "changed since last sync" | docs/scale-500.md §6 | open |
| 2 | C4 leftovers: `MIN_SHELL_VERSION` gate + `/api/version` idle-reload verified on 1.3.0 — **STOP before setting MIN_SHELL_VERSION=5 in Vercel; Nick confirms fleet is on 1.3.0** | docs/briefs/2026-09-14-premium-brand-dashboard-alerts.md | open |
| 3 | Kiosk acceptance script: `scripts/test-kiosk-flow.ts` covering bootstrap bound/unbound/throttled, link code, unseen(), buckets, per-day aggregation in America/Chicago | docs/briefs/2026-09-16-kiosk-first-run-and-orders.md | open |
| 4 | Ready screen "Send me a test order" wired to `/api/dashboard/test-order`; auto-advance 20 s | same | open |
| 5 | D3b test hygiene (whatever is still open) | docs/briefs/2026-09-15-tablet-fleet-and-followups.md | open |
| 6 | Pre-launch load test against a dev deployment — **STOP: needs Nick to create the dev deployment + a tablet login** | docs/scale-500.md | open |
| 7 | Rotate Hexnode API key + update Vercel — **STOP: Nick does this in Hexnode Admin → API before first fleet ship** | — | open |

Done today (2026-09-16): #60 I2, #61 I1, #62 alert copy, #63 D1, #64 stale-print — open, awaiting auto-merge (item 0). APK 1.3.0 (code 5) uploaded to Hexnode; policy Premium #1 v6 has device_ref=%serialnumber% and notifications=Allow.
