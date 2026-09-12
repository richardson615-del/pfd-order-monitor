-- ============================================================================
-- Migration 027: the stored password must not be readable by a tablet
-- ============================================================================
--
-- CORRECTS A FALSE CLAIM IN MIGRATION 026. That migration's own comment says:
--
--   "Service role only - restaurant_users has RLS on with no policies."
--
-- That is wrong, and it was wrong when it was written. restaurant_users has
-- RLS enabled AND a select policy, from db/schema.sql:
--
--   create policy "restaurant_users_select" on restaurant_users for select
--     using (is_admin() or belongs_to_restaurant(restaurant_id));
--
-- So every signed-in restaurant session could read its own restaurant's rows
-- of that table - and since 026 those rows contain password_current in plain
-- text. Anyone who could reach a browser console on a signed-in tablet could
-- ask PostgREST for the password directly. A kitchen tablet in kiosk mode is
-- exactly the device where "anyone with physical access" is a real population.
--
-- Not cross-restaurant: belongs_to_restaurant() confines it to their own. The
-- exposure is that a SESSION on a shared device yielded the durable PASSWORD,
-- which does not expire and which the CRM now hands out on request. Before
-- 026 there was nothing there to read.
--
-- The fix is column-level, because RLS cannot express it: a policy grants or
-- denies a ROW, and every other column on these rows is legitimately visible
-- to the restaurant it belongs to.
--
-- Safe for everything that legitimately reads this table:
--   - getCurrentUserRestaurantIds() selects restaurant_id only, never *
--   - belongs_to_restaurant() and is_admin() are SECURITY DEFINER, so they
--     run as the owner and are unaffected by client column grants
--   - the CRM bridge and admin routes use the service role, which is not
--     touched by a revoke aimed at anon and authenticated
--
-- Note this makes `select *` as an anon or authenticated client fail rather
-- than silently omit the column. That is the correct trade: a loud error in
-- development beats a credential quietly travelling to a browser.

revoke select (password_current, password_set_at)
  on restaurant_users from anon, authenticated;

-- Future columns do not inherit this, so state the rule where it will be read.
comment on column restaurant_users.password_current is
  'The tablet password in plain text, so the CRM can show it again rather than forcing a reset. SELECT on this column is revoked from anon and authenticated (migration 027) - RLS alone does NOT protect it, because restaurant_users has a select policy that admits restaurant members. Service role only. Never used for PFD staff or admin accounts.';
