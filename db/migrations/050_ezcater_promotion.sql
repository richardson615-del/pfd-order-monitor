-- ============================================================================
-- Migration 050: ezCater orders reach the kitchen and the books (Matt,
-- 2026-10-06: "continue" on the promotion package; prs-crm QUEUE row 81's
-- "then the CRM `ezcater` stream in payouts"; docs/ezcater.md)
-- ============================================================================
--
-- Migration 045 kept every ezCater order in `ezcater_orders`, away from
-- anything restaurant- or payout-facing, while ingestion was proven. This
-- is the step that moves a proven order into `orders` - the table the
-- printer queue, the tablet, the unaccepted-order alerts and the CRM's
-- accounting feed all read. Four things:
--
--   1. orders.source admits 'ezcater' (beside email / zuppler / test / phone).
--
--   2. orders.ezcater_fee - what ezCater kept before paying PFD: the
--      customer's total less ezCater's catererTotalDue (Matt, 2026-09-28).
--      The CRM's payout engine takes it off PFD's side and refuses
--      (`money_null`) an ezCater order without it, so it is stored here
--      once, at promotion, and sent on the accounting feed. Null on every
--      other source. NOT part of money_variance: the customer paid it.
--
--   3. A per-location kitchen switch, separate from `active`. `active`
--      (045) means "subscribe and store"; `send_to_kitchen` means "and
--      promote into `orders`". Off by default, so applying this migration
--      prints nothing - each location is turned on by hand on
--      /admin/ezcater, Willie Mae's first.
--
--   4. Lead time. A catering order is accepted days before it is eaten. A
--      ticket printed on Monday for Thursday's lunch gets lost on the spike,
--      and the print queue expires jobs older than PRINT_MAX_AGE_HOURS
--      anyway. So an order is promoted only once its hand-off is within
--      `kitchen_lead_hours` (default 24) - at ingest if it is already that
--      close, otherwise by the minute monitor cron when it gets there.
--      received_at is the moment of promotion: when the kitchen got it.

alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check
  check (source in ('email', 'zuppler', 'test', 'phone', 'ezcater'));

alter table orders
  add column if not exists ezcater_fee numeric(10, 2);

comment on column orders.ezcater_fee is
  'ezCater orders only (migration 050): customer total less ezCater''s catererTotalDue - what ezCater kept. Off PFD''s side in CRM payouts; never part of money_variance. Null on every other source.';

alter table ezcater_locations
  add column if not exists send_to_kitchen boolean not null default false,
  add column if not exists kitchen_lead_hours integer not null default 24;

alter table ezcater_locations drop constraint if exists ezcater_locations_lead_hours_range;
alter table ezcater_locations add constraint ezcater_locations_lead_hours_range
  check (kitchen_lead_hours between 1 and 168);

-- Promotion is only meaningful for a location whose orders are stored.
alter table ezcater_locations drop constraint if exists ezcater_locations_kitchen_needs_active;
alter table ezcater_locations add constraint ezcater_locations_kitchen_needs_active
  check (not send_to_kitchen or active);

comment on column ezcater_locations.send_to_kitchen is
  'Migration 050: promote this location''s stored orders into `orders` (print, tablet, accounting feed). Off by default; requires active.';
comment on column ezcater_locations.kitchen_lead_hours is
  'Migration 050: promote an order once its hand-off time is within this many hours (1-168, default 24).';

alter table ezcater_orders
  add column if not exists promoted_at timestamptz,
  add column if not exists promote_error text,
  -- What ezCater pays PFD for this order, as last fetched (catererTotalDue).
  add column if not exists caterer_total_due numeric(10, 2);

-- The minute cron's question: stored, live, not yet in the kitchen, due soon.
create index if not exists ezcater_orders_awaiting_promotion_idx
  on ezcater_orders (event_time)
  where status = 'accepted' and promoted_order_id is null;
