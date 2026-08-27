-- ============================================================================
-- Migration 007: link restaurants to their CRM record
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- The CRM is the system of record for which restaurants exist; this database
-- only ever learned about the ones someone added by hand. So the console could
-- show "Torino's" and creating a printer for it failed with restaurant-not-
-- found - a correct answer to the wrong question, since the restaurant is real
-- and simply had no row here yet.
--
-- An explicit external id, exactly like zuppler_restaurant_id: matching on
-- name would break the first time someone fixed a typo or two venues shared a
-- name, and it is the identifier the CRM already has.

alter table restaurants add column if not exists crm_restaurant_id text;

create unique index if not exists restaurants_crm_restaurant_id_key
  on restaurants (crm_restaurant_id) where crm_restaurant_id is not null;

comment on column restaurants.crm_restaurant_id is
  'The CRM''s own id for this restaurant. Set when the bridge auto-creates a row for a restaurant the CRM knows about and this database did not.';
