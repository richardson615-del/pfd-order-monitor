-- ============================================================================
-- Migration 014: many Zuppler ids per restaurant + explicit printer intent
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- TWO problems the CRM cross-reference exposed.
--
-- 1. A restaurant has MORE THAN ONE Zuppler id. Zuppler models a pickup menu,
--    a catering menu and a delivery menu as separate locations, so Dixie Maid,
--    Greek Style Gyro, Firecracker's, Granny's and Willie Mae's each own two
--    of the 38 ids in wave 1. restaurants.zuppler_restaurant_id is a single
--    column, so mapping them would have meant either losing one id or
--    inventing a duplicate restaurant - and a duplicate would split one
--    kitchen's tickets across two rows with two printers.
--
-- 2. Most restaurants will NEVER have a printer. Chains, liquor stores and
--    grocery pickup are on the delivery channel but are not print customers.
--    "No printer" is only a fault where a printer is actually intended.

create table if not exists restaurant_zuppler_ids (
  zuppler_restaurant_id text primary key,
  restaurant_id         uuid not null references restaurants(id) on delete cascade,
  label                 text,
  created_at            timestamptz not null default now()
);

create index if not exists restaurant_zuppler_ids_restaurant_idx
  on restaurant_zuppler_ids (restaurant_id);

alter table restaurant_zuppler_ids enable row level security;

-- Carry across what the single column already held, so nothing regresses
-- while both paths are live.
insert into restaurant_zuppler_ids (zuppler_restaurant_id, restaurant_id, label)
select zuppler_restaurant_id, id, 'migrated from restaurants.zuppler_restaurant_id'
  from restaurants
 where zuppler_restaurant_id is not null
on conflict (zuppler_restaurant_id) do nothing;

-- Printing is opt-in, per restaurant.
alter table restaurants add column if not exists printer_expected boolean
  not null default false;

-- Anything already holding a printer clearly expects one.
update restaurants r set printer_expected = true
 where exists (select 1 from print_devices d
                where d.restaurant_id = r.id and d.is_active);

comment on table restaurant_zuppler_ids is
  'Zuppler location ids belonging to a restaurant. One restaurant may own several - pickup, delivery and catering menus are separate Zuppler locations.';
comment on column restaurants.printer_expected is
  'True when this restaurant is meant to have a printer. Gates the "no printer" health warning, so the hundreds of channel restaurants that will never print stay quiet.';
