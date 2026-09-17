-- ============================================================================
-- Migration 040: how long a restaurant promises (I3, Nick 2026-09-17)
-- ============================================================================
--
-- Accept starts a countdown on the tablet from the restaurant's prep target.
-- 25 minutes unless the CRM says otherwise for that restaurant (the Devices
-- page edits it through POST /api/crm/restaurants/:id). Bounded 1..180: a
-- zero would count up from the tap, and three hours is not a promise.
--
-- Not null with a default so every existing restaurant starts on 25 and
-- the tablet never has to invent one.

alter table restaurants
  add column if not exists prep_minutes integer not null default 25;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'restaurants_prep_minutes_check') then
    alter table restaurants
      add constraint restaurants_prep_minutes_check check (prep_minutes between 1 and 180);
  end if;
end $$;

comment on column restaurants.prep_minutes is
  'Minutes the tablet counts down from when an order is accepted (I3). Default 25; the CRM sets it per restaurant. 1..180.';
