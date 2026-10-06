-- ============================================================================
-- Migration 049: the restaurant's menu on its tablet, and edits made there
-- ============================================================================
--
-- Matt, 2026-10-06: "updates need to be able to be made on tablet" - the
-- restaurant keeps its own menu current from the kitchen, it goes to the CRM,
-- and the menu agent updates Zuppler, DoorDash and ezCater from there.
--
-- The CRM is the source of the menu (its snapshot of Zuppler, or a CSV it
-- holds). It pushes the current menu here, one row per restaurant, through
-- PUT /api/crm/restaurants/:id/menu; the tablet reads it and shows a Menu
-- tab. Every entry carries the CRM's own `ref`, so an edit made by tapping
-- an item names exactly that item - no name matching anywhere.
--
-- An edit is a restaurant_messages row of kind menu_change (migration 048)
-- with `menu_changes` filled: the menu it was made against and the changes,
-- each as a line in the CRM parser's exact grammar ("price #<ref> = 24.99",
-- "86 #<ref>"). `body` stays the words a person reads in the thread.
--
-- The tablet never edits the menu here. A change is a request to Premium;
-- the item changes on the tablet when the CRM pushes the menu again after
-- publishing it, and until then the tablet shows "Sent to Premium".

create table if not exists restaurant_menus (
  restaurant_id  uuid primary key references restaurants(id) on delete cascade,
  -- The CRM's menu snapshot id. Echoed back on every edit so the CRM knows
  -- which menu the kitchen was looking at.
  crm_menu_id    text not null check (char_length(crm_menu_id) between 1 and 80),
  source         text not null check (char_length(source) between 1 and 40),
  -- { categories: [{ ref, name, items: [{ ref, name, price_cents, available, description }] }] }
  menu           jsonb not null,
  item_count     integer not null default 0 check (item_count >= 0),
  pushed_at      timestamptz not null default now()
);

alter table restaurant_menus enable row level security;

drop policy if exists restaurant_menus_select on restaurant_menus;
create policy restaurant_menus_select on restaurant_menus
  for select using (is_admin() or belongs_to_restaurant(restaurant_id));

alter table restaurant_messages
  add column if not exists menu_changes jsonb;

comment on table restaurant_menus is
  'The current menu as the CRM last pushed it, read by the tablet''s Menu tab. Written only by the CRM (PUT /api/crm/restaurants/:id/menu).';
comment on column restaurant_messages.menu_changes is
  'kind = menu_change only: { menu_id, lines[] (CRM parser grammar, by ref), changes[] (what the tablet showed) }.';
