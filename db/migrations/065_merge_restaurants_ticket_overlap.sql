-- 065: merge_restaurants could not move a duplicate whose ticket numbers overlapped its own new ones.
--
-- 064 gave the moved orders their new ticket numbers while they were still on the duplicate, then moved them.
-- Ticket numbers are unique per restaurant, so when the duplicate held tickets 1-9 and the real restaurant's
-- counter stood at 3, the first order was renumbered 4 while the duplicate's own ticket 4 still existed, and the
-- whole merge was refused (Pappy's Country Kitchen, 2026-11-20; nothing was changed). The move and the renumber
-- are now one statement, and the starting number is the higher of the counter and the last ticket actually used.
-- Everything else is 064 unchanged. Safe to run twice (create or replace).

create or replace function merge_restaurants(p_from uuid, p_into uuid, p_take_crm boolean, p_actor text)
returns jsonb
language plpgsql
as $$
declare
  f restaurants%rowtype;
  t restaurants%rowtype;
  v_crm text;
  v_primary text;
  v_counter integer;
  n jsonb := '{}'::jsonb;
  c integer;
  c2 integer;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'merge_same_restaurant' using errcode = 'P0001';
  end if;
  -- Lock both, always in the same order, so two merges can't deadlock.
  perform 1 from restaurants where id in (p_from, p_into) order by id for update;
  select * into f from restaurants where id = p_from;
  select * into t from restaurants where id = p_into;
  if f.id is null or t.id is null then
    raise exception 'restaurant_not_found' using errcode = 'P0002';
  end if;
  if not t.is_active then
    raise exception 'into_inactive' using errcode = 'P0001';
  end if;
  if exists (select 1 from restaurant_statements a join restaurant_statements b on b.period_start = a.period_start
              where a.restaurant_id = p_from and b.restaurant_id = p_into) then
    raise exception 'statement_conflict' using errcode = 'P0001';
  end if;

  -- The CRM link: `from`'s when asked for (the real account was on the duplicate), or when `into` has none.
  v_crm := case when (p_take_crm or t.crm_restaurant_id is null) and f.crm_restaurant_id is not null
                then f.crm_restaurant_id else t.crm_restaurant_id end;
  v_primary := coalesce(t.zuppler_restaurant_id, f.zuppler_restaurant_id);
  -- Free both unique columns on `from` before `into` takes them.
  update restaurants set crm_restaurant_id = null, zuppler_restaurant_id = null where id = p_from;
  update restaurants set crm_restaurant_id = v_crm, zuppler_restaurant_id = v_primary where id = p_into;

  update restaurant_zuppler_ids set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c = row_count; n := n || jsonb_build_object('zuppler_ids', c);

  -- Orders: numbered after `into`'s last ticket, oldest first. The move and the new number are ONE update:
  -- 064 renumbered first, while the orders were still on `from`, and a new number could equal a number
  -- another of `from`'s own orders still held (Pappy's, 2026-11-20: nine tickets, 1-9, renumbered 4-12).
  select greatest(coalesce(ticket_counter, 0), coalesce((select max(ticket_no) from orders where restaurant_id = p_into), 0))
    into v_counter from restaurants where id = p_into;
  with moved as (
    select id, row_number() over (order by received_at, id) as rn
      from orders where restaurant_id = p_from and ticket_no is not null
  )
  update orders o set restaurant_id = p_into, ticket_no = v_counter + moved.rn from moved where o.id = moved.id;
  get diagnostics c = row_count;
  n := n || jsonb_build_object('orders', c);
  update restaurants set ticket_counter = v_counter + c where id = p_into;
  update orders set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c2 = row_count; n := n || jsonb_build_object('orders', (n->>'orders')::int + c2);

  -- Plain moves.
  update print_devices set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c = row_count; n := n || jsonb_build_object('printers', c);
  update kiosk_devices set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c = row_count; n := n || jsonb_build_object('kiosks', c);
  update kiosk_link_codes set restaurant_id = p_into where restaurant_id = p_from;
  update printer_link_codes set restaurant_id = p_into where restaurant_id = p_from;
  update app_push_tokens set restaurant_id = p_into where restaurant_id = p_from;
  update restaurant_messages set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c = row_count; n := n || jsonb_build_object('messages', c);
  update footer_tokens set restaurant_id = p_into where restaurant_id = p_from;
  update statement_sends set restaurant_id = p_into where restaurant_id = p_from;
  update restaurant_statements set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c = row_count; n := n || jsonb_build_object('statements', c);
  update ezcater_locations set restaurant_id = p_into where restaurant_id = p_from;
  update ezcater_orders set restaurant_id = p_into where restaurant_id = p_from;
  update cook_time_log set restaurant_id = p_into where restaurant_id = p_from;
  update restaurant_login_audit set restaurant_id = p_into where restaurant_id = p_from;
  update restaurant_link_audit set restaurant_id = p_into where restaurant_id = p_from;

  -- Unique per restaurant: move what doesn't clash, the rest stays on `from` (switched off).
  update restaurant_users u set restaurant_id = p_into where u.restaurant_id = p_from
     and not exists (select 1 from restaurant_users x where x.restaurant_id = p_into and x.auth_user_id = u.auth_user_id);
  get diagnostics c = row_count; n := n || jsonb_build_object('logins', c);
  update app_owner_phones u set restaurant_id = p_into where u.restaurant_id = p_from
     and not exists (select 1 from app_owner_phones x where x.restaurant_id = p_into and x.phone = u.phone);
  update monitored_inboxes u set restaurant_id = p_into where u.restaurant_id = p_from
     and not exists (select 1 from monitored_inboxes x where x.restaurant_id = p_into and x.email_address = u.email_address);
  update push_subscriptions set restaurant_id = p_into where restaurant_id = p_from;
  update footer_events u set restaurant_id = p_into where u.restaurant_id = p_from
     and not exists (select 1 from footer_events x where x.restaurant_id = p_into and x.template_id is not distinct from u.template_id
                       and (x.payload->>'milestone') is not distinct from (u.payload->>'milestone'));

  -- One row per restaurant: `into` keeps its own.
  update dashboard_heartbeats set restaurant_id = p_into where restaurant_id = p_from
     and not exists (select 1 from dashboard_heartbeats where restaurant_id = p_into);
  update restaurant_menus set restaurant_id = p_into where restaurant_id = p_from
     and not exists (select 1 from restaurant_menus where restaurant_id = p_into);
  update restaurant_profiles set restaurant_id = p_into where restaurant_id = p_from
     and not exists (select 1 from restaurant_profiles where restaurant_id = p_into);

  update restaurants set is_active = false,
         name = case when name ~ '\(merged\)$' then name else name || ' (merged)' end
   where id = p_from;

  insert into restaurant_link_audit (restaurant_id, old_crm_restaurant_id, new_crm_restaurant_id, actor)
  values (p_into, t.crm_restaurant_id, coalesce(v_crm, ''), left(coalesce(p_actor, 'crm') || ' merged ' || p_from::text || ' into this restaurant', 200));

  return n || jsonb_build_object('crm_restaurant_id', v_crm, 'zuppler_restaurant_id', v_primary);
end;
$$;

revoke all on function merge_restaurants(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function merge_restaurants(uuid, uuid, boolean, text) to service_role;

comment on function merge_restaurants(uuid, uuid, boolean, text) is
  'Moves a duplicate restaurant (from) onto the real one (into) in one transaction and switches the duplicate off. See db/migrations/064_merge_restaurants.sql.';
