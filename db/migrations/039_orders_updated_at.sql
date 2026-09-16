-- ============================================================================
-- Migration 039: orders.updated_at - so a tablet can ask "what changed?"
-- ============================================================================
--
-- Nick, 2026-09-16 (docs/scale-500.md §6): Supabase Pro allows 500 Realtime
-- connections and the fleet is heading for 500 tablets, so Realtime becomes
-- opt-in and the poll carries the orders. A poll that pulls 200 rows a
-- minute per tablet is ~70 GB/month at 500 tablets; a poll that asks for
-- rows changed since the last one it saw is usually zero rows. That needs
-- a column that moves on every write - received_at does not.
--
-- Backfilled to received_at (the row's last known change), never to now():
-- a cursor is only compared against rows that change after it, so an
-- honest old value is right and a fresh one would be a lie. The trigger
-- stamps every UPDATE from here on; the index is the poll's whole query.

alter table orders add column if not exists updated_at timestamptz;

update orders set updated_at = coalesce(updated_at, received_at, now()) where updated_at is null;

alter table orders alter column updated_at set default now();
alter table orders alter column updated_at set not null;

create or replace function orders_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_touch_updated_at on orders;
create trigger orders_touch_updated_at
  before update on orders
  for each row execute function orders_touch_updated_at();

create index if not exists idx_orders_restaurant_updated_at
  on orders (restaurant_id, updated_at desc);

comment on column orders.updated_at is
  'Moves on every write (trigger). The tablet polls "updated_at > <last seen>" instead of the whole list - migration 039, Realtime made opt-in.';
