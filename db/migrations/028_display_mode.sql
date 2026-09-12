-- ============================================================================
-- Migration 028: how a restaurant's tablet should look
-- ============================================================================
--
-- Two looks, set per restaurant from the CRM:
--
--   kitchen  - large type, heavy contrast, an order's age counting up and
--              turning amber then red. Meant to be read across a room by
--              somebody who is not looking for it.
--
--   standard - quieter and more spacious. For a tablet on a counter that
--              somebody stands at, where the kitchen look reads as shouting.
--
-- Default is 'kitchen', because that is the failure that costs money: a
-- screen nobody notices. The quieter look is the deliberate choice for a
-- site that has asked for it, not the thing you get by not choosing.
--
-- This governs presentation only. Nothing about which orders arrive, what
-- chimes, or when an alert is raised reads this column - a display setting
-- must never be able to change whether a restaurant gets its orders.

alter table restaurants
  add column if not exists display_mode text not null default 'kitchen';

-- Named constraint, added separately so re-running is safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'restaurants_display_mode_check'
  ) then
    alter table restaurants
      add constraint restaurants_display_mode_check
      check (display_mode in ('kitchen', 'standard'));
  end if;
end $$;

comment on column restaurants.display_mode is
  'How this restaurant''s tablet renders: kitchen (large, high contrast, ageing timers) or standard (quieter, more spacing). Presentation only - nothing about delivery, chiming or alerting reads it.';
