-- 055: the order ready timer (PA5, Matt 2026-10-26).
--
-- "The restaurant app also need to be able to set timer for when order will
-- be ready and a ready button for when it ready. The driver needs to be able
-- to see this timer as well."
--
-- Accept now carries the minutes the kitchen chose (quick picks on the
-- tablet, the restaurant's prep target by default). ready_by is
-- accepted_at + those minutes, and "Running late" moves it. READY stamps
-- ready_at once: the food is on the pass. COMPLETE (completed_at) is
-- unchanged and still means the order is gone. The CRM reads all three
-- from /api/crm/orders and shows the driver the same clock.
--
-- Nullable: every order before this has none, and the countdown falls back
-- to accepted_at + restaurants.prep_minutes (lib/countdown.ts). Covered by
-- the existing orders_update RLS policy (all columns). Safe to run twice.

alter table orders add column if not exists ready_minutes integer;
alter table orders add column if not exists ready_by timestamptz;
alter table orders add column if not exists ready_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_ready_minutes_check') then
    alter table orders
      add constraint orders_ready_minutes_check check (ready_minutes is null or ready_minutes between 1 and 180);
  end if;
end $$;

comment on column orders.ready_minutes is
  'PA5: minutes the kitchen chose at Accept (1..180). Null on orders accepted before 055.';
comment on column orders.ready_by is
  'PA5: when the kitchen said the food would be ready: accepted_at + ready_minutes, moved on by "Running late".';
comment on column orders.ready_at is
  'PA5: when somebody tapped READY. Set once, never rewritten. Distinct from completed_at (the order is gone).';
