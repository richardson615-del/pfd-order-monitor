-- 059: Plain order numbers per restaurant (Matt 2026-11-11: "Currently order comes through with numbers and
-- letters but I would like for to go to restaurants and driver with a numerical number in order like we did before
-- with data dreamers. We can start everyone at order number 1 tomorrow and go up from there." Asked: one count
-- for all PFD, or each restaurant its own? "Each restaurant its own".)
--
-- orders.ticket_no: 1, 2, 3 ... per restaurant, never reset, never reused. Set by a BEFORE INSERT trigger, so
-- every source (Zuppler webhook, order email, CRM phone and web orders, ezCater, DoorDash) gets one the same way
-- and no caller can forget. Orders received before 2026-11-12 00:00 Central keep none (they show their old
-- number); TEST- orders never take one. order_number is untouched: it is still the source's own reference,
-- every dedupe and lookup keys on it, and it prints small under the new number.
--
-- restaurants.ticket_counter: the last number handed out. UPDATE ... RETURNING under the row lock, so two orders
-- at the same second get two numbers. Separate from order_counter (013), which the footer engine counts with.
-- Safe to run twice.

alter table restaurants add column if not exists ticket_counter integer not null default 0;
alter table orders add column if not exists ticket_no integer;

create unique index if not exists orders_restaurant_ticket_no_key
  on orders (restaurant_id, ticket_no) where ticket_no is not null;

create or replace function assign_order_ticket_no()
returns trigger
language plpgsql
as $$
begin
  if new.ticket_no is null
     and new.restaurant_id is not null
     and coalesce(new.received_at, now()) >= timestamptz '2026-11-12 00:00:00 America/Chicago'
     and coalesce(new.order_number, '') !~* '^TEST-' then
    update restaurants
       set ticket_counter = ticket_counter + 1
     where id = new.restaurant_id
    returning ticket_counter into new.ticket_no;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_assign_ticket_no on orders;
create trigger orders_assign_ticket_no
  before insert on orders
  for each row execute function assign_order_ticket_no();

comment on column orders.ticket_no is
  'Plain per-restaurant order number (1, 2, 3...) from 2026-11-12, set on insert. What the kitchen, the tablet, the Partner app and the driver see. Null before 2026-11-12 and on TEST- orders: show order_number.';
comment on column restaurants.ticket_counter is
  'Last ticket_no handed out for this restaurant (059). Only the orders_assign_ticket_no trigger moves it.';
