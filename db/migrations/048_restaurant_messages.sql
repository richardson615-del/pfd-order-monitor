-- ============================================================================
-- Migration 048: messages between a restaurant's tablet and dispatch
-- ============================================================================
--
-- Matt, 2026-10-06: "we should add an ability for them to send our dispatch
-- messages". Two-way: the kitchen sends from the tablet (typed, or a quick
-- pick - "where's my driver", "problem with an order"), the CRM pulls new
-- ones through GET /api/crm/messages and opens a dispatch ticket, and a
-- dispatcher's reply comes back through POST /api/crm/messages and shows on
-- the tablet with a chime.
--
--   direction   from_restaurant (the kitchen wrote it) | to_restaurant
--               (dispatch wrote it, via the CRM)
--   kind        text | driver_late | order_problem | menu_change - the quick
--               pick, so the CRM can route it without reading the words.
--               menu_change (Matt, same day): the restaurant keeps its own
--               menu current; the CRM turns it into a menu change set and the
--               menu agent publishes it to Zuppler, DoorDash and ezCater.
--   order_id    the order it is about (driver_late picks the newest open
--               delivery; order_problem is chosen by the kitchen). Null when
--               it is about nothing in particular.
--   author      who in dispatch wrote a reply (a first name), shown on the
--               tablet. Null on a restaurant's own message: the tablet has
--               one login per restaurant, so there is no person to name.
--   crm_ticket_no  the CRM ticket a reply came from, echoed so the kitchen
--               can say "ticket 1042" on the phone. Null until there is one.
--   read_at     when the tablet showed a dispatch reply (to_restaurant only);
--               what the unread badge counts.
--
-- Reads: the restaurant's own session sees its own thread (RLS, the same
-- belongs_to_restaurant() the orders policy uses). Writes go through the
-- service role in the routes, with the restaurant taken from the session or
-- the CRM key - never from a request body - so there is no insert policy.

create table if not exists restaurant_messages (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  direction text not null check (direction in ('from_restaurant', 'to_restaurant')),
  kind text not null default 'text' check (kind in ('text', 'driver_late', 'order_problem', 'menu_change')),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  order_id uuid references orders(id) on delete set null,
  author text check (author is null or char_length(author) <= 80),
  crm_ticket_no text check (crm_ticket_no is null or char_length(crm_ticket_no) <= 20),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists restaurant_messages_thread_idx
  on restaurant_messages (restaurant_id, created_at desc);

-- The CRM's feed: new kitchen messages across every restaurant, oldest first.
create index if not exists restaurant_messages_inbound_idx
  on restaurant_messages (created_at)
  where direction = 'from_restaurant';

alter table restaurant_messages enable row level security;

drop policy if exists "restaurant_messages_select" on restaurant_messages;
create policy "restaurant_messages_select" on restaurant_messages for select
  using (is_admin() or belongs_to_restaurant(restaurant_id));

comment on table restaurant_messages is
  'Messages between a restaurant tablet and Premium dispatch (048). Kitchen -> CRM via GET /api/crm/messages; dispatch replies via POST /api/crm/messages.';
