-- ============================================================================
-- Migration 043: record every relink of a restaurant to a CRM account (R1,
-- Nick 2026-09-24)
-- ============================================================================
--
-- POST /api/crm/restaurants/:id/relink moves restaurants.crm_restaurant_id
-- from one CRM account to another, so the CRM can merge a duplicate account
-- without orphaning the printers, tablets and orders hanging off this
-- restaurant. That column is the only thing joining the two systems; a
-- change to it is worth a row that says who, from what, to what, and when.
--
-- Same contract as device_key_audit (015) and restaurant_login_audit (023):
-- the bridge only sees a shared key, so the CRM names the actor; null means
-- it did not. Append-only.

create table if not exists restaurant_link_audit (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid references restaurants(id) on delete set null,
  old_crm_restaurant_id  text,
  new_crm_restaurant_id  text not null,
  actor                  text,
  created_at             timestamptz not null default now()
);

create index if not exists restaurant_link_audit_restaurant_idx
  on restaurant_link_audit (restaurant_id, created_at desc);

alter table restaurant_link_audit enable row level security;

comment on table restaurant_link_audit is
  'Every change of restaurants.crm_restaurant_id made by /api/crm/restaurants/:id/relink: actor, old and new CRM account id. Append-only.';
