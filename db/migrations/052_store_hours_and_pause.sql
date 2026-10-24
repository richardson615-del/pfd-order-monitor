-- ============================================================================
-- Migration 052: the restaurant runs its own store from the app - pause
-- online orders and change hours (Matt, 2026-10-24: "the partner portal need
-- to be part of their app that they get with the tablet"; prs-crm brief
-- docs/briefs/2026-10-24-run-everything-from-the-crm.md §2, phase A3)
-- ============================================================================
--
-- Two things a kitchen needs without calling anyone:
--
--   1. Pause online orders for a while ("we're slammed", "fryer's down").
--      The tablet owns this: restaurants.online_paused_until is set or
--      cleared by the restaurant's own session and nothing else, and every
--      change is also a restaurant_messages row of kind 'pause' so the CRM's
--      message feed carries it (the CRM stops taking web, Muse and phone
--      orders for the restaurant, and opens a ticket so dispatch pauses
--      Zuppler too while Zuppler is still on).
--
--   2. Change the weekly hours. The CRM keeps the hours (accounts.hours,
--      what open-now and ordering read) and pushes them here in
--      restaurant_profiles. The tablet edits a copy and sends it as a
--      restaurant_messages row of kind 'hours_change' with the new week in
--      `details`; the CRM applies it and pushes the profile back, which is
--      when the tablet stops showing "Sent to Premium".
--
-- `details` is the structured half of a message whose `body` is the words a
-- person reads, the same split menu_change uses with `menu_changes`.

alter table restaurants
  add column if not exists online_paused_until timestamptz,
  add column if not exists online_pause_reason text check (online_pause_reason is null or char_length(online_pause_reason) <= 200),
  add column if not exists online_paused_at timestamptz;

alter table restaurant_messages drop constraint if exists restaurant_messages_kind_check;
alter table restaurant_messages add constraint restaurant_messages_kind_check
  check (kind in ('text', 'driver_late', 'order_problem', 'menu_change', 'pause', 'hours_change'));

alter table restaurant_messages
  add column if not exists details jsonb;

-- What the CRM last pushed about the restaurant for the Store tab.
create table if not exists restaurant_profiles (
  restaurant_id  uuid primary key references restaurants(id) on delete cascade,
  -- { sunday: [{ open: "11:00", close: "21:00" }], monday: [], ... } - [] = closed that day; null = none on file.
  hours          jsonb,
  -- The CRM's own words for the week, one line per day, for display.
  hours_lines    text[] not null default '{}',
  ordering_channel text check (ordering_channel is null or ordering_channel in ('zuppler', 'both', 'pfd')),
  pushed_at      timestamptz not null default now()
);

alter table restaurant_profiles enable row level security;

drop policy if exists restaurant_profiles_select on restaurant_profiles;
create policy restaurant_profiles_select on restaurant_profiles
  for select using (is_admin() or belongs_to_restaurant(restaurant_id));

comment on column restaurants.online_paused_until is
  'Online orders paused by the restaurant until this instant (migration 052). Set and cleared only from the restaurant''s own session; each change is also a restaurant_messages row of kind pause.';
comment on table restaurant_profiles is
  'The restaurant''s hours as the CRM last pushed them (PUT /api/crm/restaurants/:id/profile), read by the Store tab. Written only by the CRM.';
comment on column restaurant_messages.details is
  'Structured half of a pause / hours_change message: { paused_until, reason } or { hours, note }.';
