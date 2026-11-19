-- 064: Merge a duplicate restaurant into the real one (Matt 2026-11-19).
--
-- El Vaquero had two restaurants here: Zuppler orders and the printer on one, CRM phone orders on the other,
-- so phone orders never printed. China One, Ariella and Pappy's had the same split. Until now the bridge could
-- only relink a CRM account (043) and refused to move a Zuppler listing between restaurants, so a duplicate
-- could not be fixed without hand-written SQL.
--
-- merge_restaurants(from, into, take_crm, actor) moves everything that hangs off `from` onto `into`, in one
-- transaction, then switches `from` off:
--   * Zuppler listings (restaurant_zuppler_ids and the primary column) and, when asked or when `into` has
--     none, the CRM account link;
--   * orders, renumbered after `into`'s last ticket number (ticket numbers are unique per restaurant);
--   * printers, kiosks, tablets, logins, owner phones, inboxes, messages, menus, statements, footer data,
--     ezCater links, cook-time log and every audit row.
-- Tables with one row per restaurant (heartbeat, menu, profile) keep `into`'s row when both have one.
-- Rows that would clash on a unique key (same login, phone, inbox, push endpoint) stay with `from`.
-- A statement period both restaurants have refuses the whole merge: money documents are never overwritten.
-- Every merge writes a restaurant_link_audit row. Safe to run twice (create or replace).

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

  -- Orders: numbered after `into`'s last ticket, oldest first.
  select ticket_counter into v_counter from restaurants where id = p_into;
  with moved as (
    select id, row_number() over (order by received_at, id) as rn
      from orders where restaurant_id = p_from and ticket_no is not null
  )
  update orders o set ticket_no = v_counter + moved.rn from moved where o.id = moved.id;
  get diagnostics c = row_count;
  update restaurants set ticket_counter = v_counter + c where id = p_into;
  update orders set restaurant_id = p_into where restaurant_id = p_from;
  get diagnostics c = row_count; n := n || jsonb_build_object('orders', c);

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
