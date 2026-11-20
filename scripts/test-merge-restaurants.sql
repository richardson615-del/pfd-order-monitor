-- Test for db/migrations/064_merge_restaurants.sql. Runs against a throwaway database that has
-- db/schema.sql and every migration applied (see the header of scripts/test-merge-restaurants.sh).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a@x'), ('00000000-0000-0000-0000-0000000000a2', 'b@x');
-- The real restaurant: Zuppler listing, printer, two orders already numbered 1 and 2, a menu.
insert into restaurants (id, name, slug, crm_restaurant_id, zuppler_restaurant_id, ticket_counter)
values ('11111111-1111-1111-1111-111111111111', 'El Vaquero', 'elv-1', 'aaaaaaaa-0000-0000-0000-000000000001', '29923', 0);
insert into restaurant_zuppler_ids (zuppler_restaurant_id, restaurant_id) values ('29923', '11111111-1111-1111-1111-111111111111');
insert into print_devices (restaurant_id, name, device_key) values ('11111111-1111-1111-1111-111111111111', 'Kitchen', 'k-into');
insert into orders (id, restaurant_id, order_number, source, received_at)
values ('00000000-0000-0000-0000-000000000101', '11111111-1111-1111-1111-111111111111', 'Z-1', 'zuppler', now() - interval '2 days'),
       ('00000000-0000-0000-0000-000000000102', '11111111-1111-1111-1111-111111111111', 'Z-2', 'zuppler', now() - interval '1 day');
insert into restaurant_menus (restaurant_id, crm_menu_id, source, menu) values ('11111111-1111-1111-1111-111111111111', 'm1', 'test', '{"keep":"into"}');
insert into restaurant_users (restaurant_id, auth_user_id) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a1');

-- The duplicate: the real CRM account, a second Zuppler listing, an old printer, two phone orders (1 and 2), a login
-- that both have and one only it has, its own menu and a statement.
insert into restaurants (id, name, slug, crm_restaurant_id, ticket_counter)
values ('22222222-2222-2222-2222-222222222222', 'El Vaquero', 'elv-2', 'bbbbbbbb-0000-0000-0000-000000000002', 0);
insert into restaurant_zuppler_ids (zuppler_restaurant_id, restaurant_id) values ('32722', '22222222-2222-2222-2222-222222222222');
insert into print_devices (restaurant_id, name, device_key, is_active) values ('22222222-2222-2222-2222-222222222222', 'Old', 'k-from', false);
insert into orders (id, restaurant_id, order_number, source, received_at)
values ('00000000-0000-0000-0000-000000000201', '22222222-2222-2222-2222-222222222222', 'P-1', 'phone', now() - interval '3 hours'),
       ('00000000-0000-0000-0000-000000000202', '22222222-2222-2222-2222-222222222222', 'P-2', 'phone', now() - interval '1 hour');
insert into restaurant_menus (restaurant_id, crm_menu_id, source, menu) values ('22222222-2222-2222-2222-222222222222', 'm2', 'test', '{"keep":"from"}');
insert into restaurant_users (restaurant_id, auth_user_id) values ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000a1'),
                                                                  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000a2');
insert into restaurant_statements (restaurant_id, period_start, period_end, statement_no, amount_due_cents)
values ('22222222-2222-2222-2222-222222222222', '2026-11-01', '2026-11-07', 'S-1', 0);

-- Refusals.
do $$ begin
  begin perform merge_restaurants('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', false, 't');
        raise exception 'same restaurant was allowed';
  exception when others then if sqlerrm <> 'merge_same_restaurant' then raise; end if; end;
  begin perform merge_restaurants('22222222-2222-2222-2222-222222222222', '99999999-9999-9999-9999-999999999999', false, 't');
        raise exception 'missing restaurant was allowed';
  exception when others then if sqlerrm <> 'restaurant_not_found' then raise; end if; end;
end $$;

-- A statement period both have refuses, and changes nothing.
insert into restaurant_statements (restaurant_id, period_start, period_end, statement_no, amount_due_cents)
values ('11111111-1111-1111-1111-111111111111', '2026-11-01', '2026-11-07', 'S-9', 0);
do $$ begin
  begin perform merge_restaurants('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', true, 't');
        raise exception 'statement clash was allowed';
  exception when others then if sqlerrm <> 'statement_conflict' then raise; end if; end;
end $$;
delete from restaurant_statements where statement_no = 'S-9';

-- The merge, taking the duplicate's CRM account (the real one).
select merge_restaurants('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', true, 'test') as result \gset
\echo :result

do $$
declare r restaurants%rowtype; d restaurants%rowtype;
begin
  select * into r from restaurants where id = '11111111-1111-1111-1111-111111111111';
  select * into d from restaurants where id = '22222222-2222-2222-2222-222222222222';
  assert r.crm_restaurant_id = 'bbbbbbbb-0000-0000-0000-000000000002', 'into takes the duplicate CRM link';
  assert r.zuppler_restaurant_id = '29923', 'into keeps its primary listing';
  assert d.crm_restaurant_id is null and d.zuppler_restaurant_id is null, 'duplicate keeps no link';
  assert not d.is_active and d.name = 'El Vaquero (merged)', 'duplicate is switched off and named';
  assert (select count(*) from restaurant_zuppler_ids where restaurant_id = r.id) = 2, 'both listings route to into';
  assert (select count(*) from orders where restaurant_id = r.id) = 4, 'all orders on into';
  assert (select array_agg(ticket_no order by received_at) from orders where restaurant_id = r.id) = array[1,2,3,4], 'moved orders numbered after into';
  assert r.ticket_counter = 4, 'counter advanced';
  assert (select count(*) from print_devices where restaurant_id = r.id) = 2, 'printers moved';
  assert (select menu->>'keep' from restaurant_menus where restaurant_id = r.id) = 'into', 'into keeps its menu';
  assert (select count(*) from restaurant_users where restaurant_id = r.id) = 2, 'new login moved, clashing one skipped';
  assert (select count(*) from restaurant_users where restaurant_id = d.id) = 1, 'clashing login stays on duplicate';
  assert (select count(*) from restaurant_statements where restaurant_id = r.id) = 1, 'statement moved';
  assert (select count(*) from restaurant_link_audit where restaurant_id = r.id) = 1, 'audit written';
  -- A new order on into continues the numbering.
  insert into orders (restaurant_id, order_number, source) values (r.id, 'Z-3', 'zuppler');
  assert (select ticket_no from orders where order_number = 'Z-3') = 5, 'next order is 5';
end $$;

-- Without take_crm, into keeps its own link.
insert into restaurants (id, name, slug, crm_restaurant_id) values ('33333333-3333-3333-3333-333333333333', 'China One', 'c1', 'cccccccc-0000-0000-0000-000000000003'),
                                                               ('44444444-4444-4444-4444-444444444444', 'China One', 'c2', null);
select merge_restaurants('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', false, 'test') \gset
do $$ begin
  assert (select crm_restaurant_id from restaurants where id = '33333333-3333-3333-3333-333333333333') = 'cccccccc-0000-0000-0000-000000000003', 'into keeps its link';
end $$;
-- 065: the duplicate's ticket numbers overlap the numbers they are about to get (Pappy's, 2026-11-20).
insert into restaurants (id, name, slug, zuppler_restaurant_id, ticket_counter) values ('55555555-5555-5555-5555-555555555555', 'Pappys', 'p1', '32905', 3),
                                                                                     ('66666666-6666-6666-6666-666666666666', 'Pappys', 'p2', '32906', 9);
insert into orders (restaurant_id, order_number, source, received_at, ticket_no)
select '55555555-5555-5555-5555-555555555555', 'K-' || g, 'zuppler', now() - (20 - g) * interval '1 hour', g from generate_series(1, 3) g;
insert into orders (restaurant_id, order_number, source, received_at, ticket_no)
select '66666666-6666-6666-6666-666666666666', 'D-' || g, 'zuppler', now() - (10 - g) * interval '1 hour', g from generate_series(1, 9) g;
select merge_restaurants('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555', false, 'test') \gset
do $$ begin
  assert (select array_agg(ticket_no order by ticket_no) from orders where restaurant_id = '55555555-5555-5555-5555-555555555555') = array[1,2,3,4,5,6,7,8,9,10,11,12], 'overlapping tickets renumbered 4-12';
  assert (select ticket_no from orders where order_number = 'D-1') = 4 and (select ticket_no from orders where order_number = 'D-9') = 12, 'oldest moved order first';
  assert (select ticket_counter from restaurants where id = '55555555-5555-5555-5555-555555555555') = 12, 'counter at 12';
  assert not exists (select 1 from orders where restaurant_id = '66666666-6666-6666-6666-666666666666'), 'nothing left on the duplicate';
end $$;
\echo merge_restaurants tests passed
rollback;
