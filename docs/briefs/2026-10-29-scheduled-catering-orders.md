# Claude Code instruction package — Workstream SC: scheduled (future-dated) catering orders on the tablet + "Catering" wording

Repo: `pfd-order-monitor` (bridge + tablet app). Nick, 2026-10-29, from Willie Mae's tablet: ezCater order **#GJ3P08** ($961.05, 2x Party Pack 20 people, delivery to Franklin KY) is **due tomorrow (Fri 10/30)** but the tablet shows it as a today order — red age timer counting up from arrival (45:59), accept/ready flow as if cooking now. And the restaurant must never see "ezCater"; it should say **"Catering"**.

Repo rules (README, `docs/crm-bridge-contract.md`, QUEUE header) win over this brief — stop and say so on conflict. Branch -> CI green -> `gh pr merge --auto --squash`; never push main; never `vercel --prod*`; never print `.env*`; migrations sequential (next after 055) — **none expected**.

## Ground truth

FACT (read from code at `0ebc635`, 2026-10-28):
- ezCater orders are promoted into `orders` `kitchen_lead_hours` before hand-off (default **24 h**, 1-168) — `lib/ezcater-promote.ts` `promotionDecision` (~l.70-77). `received_at` = promotion moment; `due_time` = ezCater `eventTime` hand-off (`lib/ezcater.ts:142`).
- Every tablet clock keys on `received_at`, not `due_time`:
  - card age timer + rail colour: `elapsedLabel` / `ageClass` / `isLate` in `lib/order-display.ts` (amber 5 min, red 10 min).
  - list membership: `bucketOf` (`lib/order-display.ts`) drops a non-settled order out of **Orders** 6 h after `received_at` (`STILL_ACTIONABLE_MS`, `lib/kiosk.ts:61`). **Consequence: an order promoted 24 h early vanishes from the Orders list ~18 h before it is due and lands in Past week.**
  - hero line "late": `heroSummary` (`lib/countdown.ts` ~l.124).
  - chime: `unaccepted()` (`lib/kiosk.ts` ~l.80) — fine (acknowledging receipt is wanted).
  - office alert `order_unaccepted` (`lib/health.ts` ~l.387): text says "the customer is waiting" — wrong for a next-day order.
  - CRM flag `unaccepted_over_3m` (`lib/crm-orders.ts` ~l.246).
  - Accept starts the prep countdown from `accepted_at` (`lib/countdown.ts`, `lib/ready-timer.ts`) — meaningless 24 h out.
- Tablet ticket shows `{kind} at {timeLabel(due_time)}` — **time only, no date** (`components/OrderViewer.tsx:201-205`, `lib/local-day.ts:68`). The **printed** ticket already prints weekday + date (`lib/ticket.ts` `localTime`, l.121-129).
- "ezCater" text a restaurant sees:
  - NOTE banner `*** ezCATER CATERING ***` — `EZCATER_TICKET_BANNER`, `lib/ezcater-promote.ts:43` (printed + tablet).
  - notes line `ezCater #<number>` — `lib/ezcater-client.ts:326`.
  - payment type `ezCater (prepaid)` — `lib/ezcater.ts:152`.
  - Sales tab channel `channelLabel("ezcater") -> "ezCater"` — `lib/sales.ts:163`.
- Standing decision: the tablet dashboard shows no order source.

ASSUMPTION (Nick's intent):
- Applies to any order whose `due_time` is well ahead of now, not just ezCater. ezCater is the only source producing them today.
- Restaurant still acknowledges receipt (chime + Accept) when it arrives; cooking clocks start only near the due time.
- Internal surfaces (`/admin/ezcater`, CRM accounting feed, `source = 'ezcater'`, `ezcater_fee`) keep the real name.

UNKNOWN (probe first, report):
- Willie Mae's `kitchen_lead_hours` in prod (read-only query) and GJ3P08's `due_time`.
- Whether the CRM's restaurant statements/payout PDFs print "ezCater" — grep prs-crm `ezcater|ezCater` in restaurant-facing output; report only, separate PR in prs-crm if found.

## SC1 — Scheduled orders (bridge)

Build:
1. `lib/order-display.ts`: add `SCHEDULED_AHEAD_MS` (**default 2 h**) and pure helpers:
   - `isScheduled(order, now)` — not settled, `due_time` readable, `due_time - now > SCHEDULED_AHEAD_MS`.
   - `kitchenClockStart(order)` — `received_at` for ordinary orders; for orders that were scheduled, `due_time - SCHEDULED_AHEAD_MS` (so a catering order turns into a normal kitchen order 2 h before hand-off, not with 22 h of "age").
   - `dueLabel(due_time, now, tz)` -> "Today 11:30 AM" / "Tomorrow 11:30 AM" / "Fri, Oct 30 · 11:30 AM".
2. Make every received_at clock use `kitchenClockStart`: `ageMs`/`elapsedLabel`/`ageClass`/`isLate`, `bucketOf` (scheduled orders stay in **Orders** until `due_time + STILL_ACTIONABLE_MS`), `heroSummary` late test, `kitchenSort` (scheduled orders sort **after** current ones, by `due_time`), `lib/crm-orders.ts` `unaccepted_over_3m` age.
3. `components/OrderCard.tsx` when `isScheduled`: pill **"Scheduled"** (calm tone, new CSS class, token colours) in place of countdown/age; right-hand timer replaced by `Due Tomorrow 11:30 AM`; rail calm; **Accept** still shown (no minute picks); **Ready / +5 / +10 hidden**.
4. Accept on a scheduled order: stamps `accepted_at` (stops chime + office alert) but **no prep countdown** — `countdown()` returns null while `isScheduled`; once it stops being scheduled the countdown runs to `due_time` (set `ready_by = due_time` at that point, or compute it — pick the smaller change and say which).
5. `components/OrderViewer.tsx`: due line uses `dueLabel` (date when not today); big timer shows `dueLabel` instead of age while scheduled. Dashboard Orders tab: a small "Scheduled" divider above scheduled cards.
6. `lib/health.ts` `order_unaccepted`: for a scheduled order, severity **warning** and detail "Catering order for <dueLabel> not acknowledged on the tablet" (no "customer is waiting").
7. Printing unchanged (prints at promotion; ticket already dated).

Tests (`scripts/test-scheduled-orders.ts`, wired into the test script): due tomorrow -> scheduled, in Orders bucket at +7 h/+20 h, not late, sorts last, no countdown after Accept, label "Tomorrow ..."; due in 90 min -> ordinary; becomes ordinary at due-2 h with age counted from there; settled never scheduled; missing/invalid `due_time` -> ordinary; existing kiosk/countdown/sales tests still pass.

Acceptance: GJ3P08 (or a test order with `due_time` tomorrow) shows "Scheduled · Due Tomorrow ...", calm, stays on the list overnight, turns into a normal order 2 h before due.

## SC2 — "Catering", never "ezCater", on restaurant-facing surfaces (bridge)

1. `EZCATER_TICKET_BANNER` -> `"*** CATERING ***"`; notes line `ezCater #` -> `Catering #`; `paymentType` -> `"Catering (prepaid)"`; `channelLabel("ezcater")` -> `"Catering"`.
2. Rows already stored keep the old text: add one display-time cleaner used by `TicketBody`, the card, `buildTicket` and reprints — for `source === "ezcater"`, replace `ezCATER CATERING` -> `CATERING`, `ezCater #` -> `Catering #`, `ezCater (prepaid)` -> `Catering (prepaid)` (case-insensitive). No data rewrite.
3. Grep restaurant-facing tablet code (`components/`, `lib/ticket*`, `lib/sales*`, Money/Store tabs) for any remaining `ezCater` and fix; leave `EzCaterAdmin`, `/admin`, `/api/crm/*`, accounting, DB values alone.
4. Update tests that pin the old strings (`test-ezcater-promote.ts` banner/paymentType, `test-ezcater.ts` paymentType, `test-sales.ts` channelLabel) and add a test: no restaurant-facing render of an ezCater order contains "ezcater" (case-insensitive).
5. Update `docs/ezcater.md` (banner text).

Acceptance: GJ3P08's ticket on the tablet and on a reprint reads CATERING / Catering #GJ3P08 / Catering (prepaid); Sales tab channel "Catering"; /admin/ezcater unchanged.

## Order of work

SC2 first (small, independent), then SC1. One PR each. Add a QUEUE row for each in `docs/briefs/QUEUE.md`.

## Open questions — defaults Claude Code takes

| Question | Default |
|---|---|
| How far ahead counts as "scheduled"? | **2 h** (constant, not per-restaurant) |
| Keep chime + Accept for scheduled orders? | **Yes — chime once on arrival, Accept acknowledges** |
| When does it become a normal kitchen order? | **2 h before due** |
| Change `kitchen_lead_hours` default? | **No** (stays 24 h) |
| Fix CRM statements if they say ezCater? | **Report only; separate prs-crm brief** |
