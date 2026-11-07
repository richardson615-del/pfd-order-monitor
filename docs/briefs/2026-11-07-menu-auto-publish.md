# Claude Code instruction package — Workstream MP: approved menu changes publish without a second click (Nick, 2026-11-07)

**Ticket context:** sets #12–#17 on `/menus/changes` were all stuck at **Publishing** (tickets #1142, #1303, #1352, #1394). Nick 11/7: they were one-day sold-outs (#12 was a test), so they were cancelled and their tickets closed by hand. **Do not republish any of them.**
**Owner clone:** prs-crm (main) · **Queue row:** 287 (add it when you claim) · **Size:** MP1 small (prs-crm only); MP2 two PRs (pfd-order-monitor first, then prs-crm) · **Migration:** none expected

## What's wrong (verified 2026-11-07)
- The menu agent on PFDJacob is up (`/admin/menus`: "last heard 0 min ago").
- Set #17 (Depot, Soup of the Day 86) → Zuppler job = **Handed back to a person**, `not_published_in_time: Nobody clicked Publish within 30 min; the edits were discarded`.
- The cause is in the code: `publishing.ts:505-506` only saves itself when `menu_change_sets.auto_publish = true`, and that flag is set in **one** place only: Pete's "Make this change" (`pete-menu-changes.ts:102`). So:
  - a person approving on `/menus/changes/<id>` (`change-sets.ts:431`) → no `auto_publish`,
  - the `menu_sync_auto_86` rule (`close-loop.ts maybeAutoApprove`) → approves and starts publishing but never sets `auto_publish`,
  - tablet Menu-tab changes ("Menu change from the tablet", already exact) → same.
  Every one of these stages the change in Chef and then waits for someone to click Publish on the review page. Nobody does, so after 30 minutes the edits are thrown away.

## Nick's rule
Pete (and any approval) should publish menu changes on its own. Approving **is** the Publish.

## Build (MP1)
1. Set `auto_publish = true` whenever a set reaches `approved` by:
   - a person's Approve (`approveMenuChangeSet`),
   - `maybeAutoApprove` (the `menu_sync_auto_86` rule),
   - a set created from a tablet Menu-tab message (the ticket kind `menu_change` / the change set is exact). These should also go straight to approved, since the restaurant made the change itself and it is item 86/un-86 or hours only. Anything else from the tablet waits for a person as before.
2. Keep the existing guardrails: `auto_publish` still needs `approved_by` and `status = 'publishing'` (`publishing.ts:506`). Big-change / flagged sets and ops the playbook can't do (add, delete, options, multi-size) still go to a person. Never auto-publish a set whose base menu isn't current.
3. Stuck sets: add an admin button **"Publish now"** on a set in `staged` / `handed back · not_published_in_time`. It sets `auto_publish` and calls the existing "Retry with the worker". **No** one-time republish script: sets #12–#17 were cancelled on purpose.
4. Turn on `menu_sync_auto_86` by default? **No**, leave the setting alone and say in the PR that Nick can flip it on `/admin/settings` ("Approve menu 86s without a person").
5. Daily brief line already counts "waiting approval / failed". Add "**handed back — nobody published**" so this can't hide again.
6. Docs: update `docs/claude/menus-and-zuppler.md` §Publishing (approval = publish; the 30-min hand-back now only happens for sets that aren't auto_publish).

## MP2 — "How long is it sold out?" (Nick, 11/7)
Every time someone blocks (86s) an item, ask how long. Never leave a one-day sold-out on the menu forever.

**FACT (read 11/7):** the 86 op already has `payload.until` (`ops-shared.ts:83`: present = back on at that time, absent = until someone changes it). The parser fills it only if the text says so (`parser.ts:116,232`). Nothing acts on it: `publish-shared.ts:62-91` only adds the note "bring it back … at the given time", so a person has to remember. The docs list "86-until in the UI" as not built (`menus-and-zuppler.md:329`).

**Ask on every 86 path**, with the same three choices everywhere:
- **Rest of today** *(default)*: back on at the restaurant's next opening time (account hours). If the hours are missing, 4:00 AM local.
- **Back at…**: a time picker, today or tomorrow.
- **Until we turn it back on**: no `until`.

Paths:
1. **Tablet Menu tab (pfd-order-monitor, PR 1, merges first):** on Sold out / 86, show the three choices before saving. Send `until` (ISO with offset, or null) on each line of the `menu_changes` payload. Update `docs/crm-bridge-contract.md` with the new field. Old tablets that send no field are treated as **Rest of today**.
2. **CRM (prs-crm, PR 2):** read `until` from the bridge message (`restaurant-messages-shared.ts:93`) into the op. The `/menus/changes` new-change form and Pete's PM1 "Make this change" card show the same three choices on any 86 op. If the parser found no time, it defaults to Rest of today and lets the person change it.
3. **Bring it back automatically:** a cron (every 15 min, `vercel.json`, extend an existing menu cron if there is one) finds verified 86 ops whose `until` has passed and that haven't been superseded. It creates one un-86 change set per restaurant, approved by the system and `auto_publish` (MP1), linked to the original ticket. That set's read-back closes the ticket. If the restaurant un-86s first, nothing happens. Audit `menu_change.auto_un86`.
4. Show "86'd until 4:00 AM" (or "until turned back on") on the change set page, the ticket line and the tablet's Menu tab.

**Tests:** default is Rest of today; next-opening calculation including a closed day and missing hours; the cron skips superseded or already-available items and makes one set per restaurant; an old tablet payload without `until` is treated as Rest of today; contract test in both repos.

## Tests
- Unit: approve paths set `auto_publish` (person, rule, tablet-exact). Flagged/big sets don't.
- `recordStaged` with `auto_publish` requests the save. Without it, still waits (regression).
- Worker contract test unchanged.

## Acceptance (Nick)
- MP2: 86 an item on a test tablet with "Back at" set 20 min out. It publishes with no click, then comes back on by itself within ~35 min, and the ticket closes.
- MP1:
Approve a one-item 86 on a test restaurant, then within ~5 min the set is `done`/`partial` with Zuppler **verified**, no Publish click, and the Menu update ticket closes itself.
