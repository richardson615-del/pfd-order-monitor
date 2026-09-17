# Claude Code instruction package — Workstream I3: Accept + 25-minute countdown (`pfd-order-monitor`)

Author: Nick Davies. Date: 2026-09-17. Obey `README.md`; repo rules win — stop and say so. One PR `feat/accept-countdown`, auto-merge on green. Web-only: no APK.

## Nick's decision (2026-09-17) — supersedes I2 §2 "No Accept step"
After watching the shipped I2 flow on a live tablet: an order that only offers **Done** gives the kitchen no way to say "we've got it" and no sense of time. New flow, verbatim intent: **"Order comes in → they click Accept to stop the notification → a 25-minute countdown starts → they can click Complete to finish sooner."**

I2's model stays (Orders / Completed / Past week; DB statuses untouched; `accepted_at` column already exists from migration 021). This changes what happens inside the Orders bucket.

## Flow
1. **New order arrives.** Card shows **NEW**, chime repeats every 8 s, push notification fires. Opening the ticket does **not** stop the chime any more (reverts I2 §2.2's `unseen()` rule).
2. **Accept** — one tap, on the card *and* on the ticket. Sets `accepted_at = now()` via the existing `PATCH /api/orders/:id {accepted:true}`. Chime stops for that order. The card's NEW pill becomes a **countdown**.
3. **Countdown** — starts at **25:00** and counts down. Card and ticket show it large. Colour: calm until 5:00 left, **amber under 5:00**, **red at 0:00** and then counts *up* ("+3:12 over") so nobody loses track — it never auto-completes and never disappears (an order left on the board is a real problem, not something to hide). One short chime (not the repeating one) at 0:00.
4. **Complete** — the button is labelled **Complete** (was Done). Available any time after Accept. Sets `status = completed`, moves the order to Completed with the actual prep time recorded (`completed_at − accepted_at`).
5. An order that is **not accepted** keeps chiming until accepted — same 6-hour ceiling as today so an abandoned order doesn't ring forever.

## Rules
- `unseen()` → **`unaccepted()`** (the pre-I2 helper, still in `lib/order-display.ts` history): chime while `accepted_at IS NULL AND status NOT IN (completed, cancelled) AND received < 6 h`.
- Prep target **25 minutes** by default, stored per restaurant: `restaurants.prep_minutes INTEGER NOT NULL DEFAULT 25` (migration, idempotent, add to `REQUIRED_SCHEMA`). Exposed on `GET/POST /api/crm/restaurants/:id` so the CRM's Devices page can edit it later (contract doc updated; CRM UI is a separate small item, not this PR).
- Countdown is computed client-side from `accepted_at + prep_minutes`, so it survives reloads and idle-time refreshes and needs no timer state on the server.
- Hero line on Orders: "**3** orders · 1 not accepted · next up in 04:10" — counts unaccepted first, then the soonest countdown.
- Sort: unaccepted orders first (oldest first), then accepted by least time remaining.
- Completed row shows "Accepted 6:02 · Done 6:19 (17 min)".
- Past week unchanged.

## Tests (`scripts/test-*.ts`, pure)
- `unaccepted()` chime rule incl. the 6 h ceiling; countdown math at accept, at 5:00, at 0:00, at −3:12; sort order; hero line strings; `prep_minutes` default and per-restaurant override.

## Acceptance (on the Twisted Fork tablet)
- Test order arrives → chime + NEW → tap **Accept** → chime stops, **25:00** starts → tap **Complete** at any point → Completed shows the real minutes. Leave one order past 0:00 → turns red, counts up, one short chime, stays on the board.
- Screenshots 800×1280: card NEW, card counting down, card red/over, ticket with Accept, ticket with countdown + Complete.

## Decided (Nick, 2026-09-17)
At 0:00: turn red, count up, **one single short chime**, never auto-complete. No repeating alarm. No open questions — build it.
