-- 063: restaurants can't rewrite their orders' money columns (Z-03, High).
-- prs-crm QUEUE row 294, brief prs-crm docs/briefs/2026-11-07-z-bridge-orders-column-grants.md.
--
-- Policy orders_update let any member of a restaurant update EVERY column of
-- its own orders through PostgREST (anon key + their own session), including
-- customer_total, tip, fees and items, which the CRM payout feed reads.
-- RLS scopes rows, not columns, so the fix is column grants (as in 027).
--
-- The user-scoped (non-service-role) writes to orders, read 2026-11-15:
--   app/api/orders/[id]/route.ts  accepted_at, ready_minutes, ready_by (accept / retime),
--                                 ready_at (+ accepted_at) (ready),
--                                 status + opened_at / completed_at / printed_at (status)
--   app/order/[id]/page.tsx       opened_at, status (first look)
-- updated_at is stamped by the 039 trigger; granted too so a client that sends it keeps working.
-- Every other orders write uses supabaseAdmin() (service role), which grants don't touch.
-- is_admin() and belongs_to_restaurant() are SECURITY DEFINER, unaffected.
--
-- scripts/test-orders-grants.ts pins the money columns out of this grant list.
-- Safe to run twice.

revoke update on table orders from authenticated, anon;

grant update (status, opened_at, completed_at, printed_at, accepted_at, ready_minutes, ready_by, ready_at, updated_at)
  on table orders to authenticated;

-- A row can't be moved to another restaurant: the new row must pass the same test as the old one.
alter policy "orders_update" on orders
  using (is_admin() or belongs_to_restaurant(restaurant_id))
  with check (is_admin() or belongs_to_restaurant(restaurant_id));

comment on table orders is
  'UPDATE for authenticated is column-limited (migration 063): status and the opened/accepted/ready/printed/completed timers only. Money columns, items, raw_payload and restaurant_id are service role only. A new client-written column needs a grant in a new migration.';
