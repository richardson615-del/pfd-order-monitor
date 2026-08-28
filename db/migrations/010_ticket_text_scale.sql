-- ============================================================================
-- Migration 010: large-print tickets
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- An accessibility setting, not a preference: a cook who cannot read the
-- ticket cannot cook the order, and 48-column thermal text at arm's length is
-- genuinely hard for a lot of people.
--
-- Device-level overrides restaurant-level, because a kitchen may want the
-- expo station large and the line station normal - the setting belongs to
-- whoever is reading that particular printer, not to the business.
-- NULL on the device means "inherit the restaurant's default".

alter table restaurants add column if not exists ticket_text_scale text
  not null default 'normal';
alter table restaurants drop constraint if exists restaurants_ticket_text_scale_check;
alter table restaurants add constraint restaurants_ticket_text_scale_check
  check (ticket_text_scale in ('normal', 'large'));

alter table print_devices add column if not exists text_scale text;
alter table print_devices drop constraint if exists print_devices_text_scale_check;
alter table print_devices add constraint print_devices_text_scale_check
  check (text_scale is null or text_scale in ('normal', 'large'));

comment on column restaurants.ticket_text_scale is
  'Default ticket text size for this restaurant: normal | large.';
comment on column print_devices.text_scale is
  'Overrides the restaurant default for this station. Null inherits.';
