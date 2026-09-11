-- ============================================================================
-- Migration 026: keep the tablet password so the CRM can show it again
-- ============================================================================
--
-- Until now a restaurant password was shown once and then existed only in
-- Supabase's hash. A forgotten one was replaced, never recovered. Migration
-- 023's own comment argued for that, and against exactly what this migration
-- does: "storing the value would turn an audit trail into a second place
-- credentials live."
--
-- That reasoning still holds for the AUDIT table, and nothing here changes it
-- - restaurant_login_audit still records no password. What changed is the
-- decision about the credential itself, which Nick made deliberately after
-- being shown the trade: these logins guard a restaurant's own order screen,
-- PFD controls which tablets the app goes on, and in practice a password
-- nobody can look up means a reset every time a tablet is replaced or a
-- manager forgets, each of which is a phone call during service.
--
-- So the password is stored, readable by the service role only, and reading
-- it is audited as its own action. That is the same shape migration 015 gave
-- printer device keys, which are also stored and also revealable - this makes
-- the two credentials consistent rather than inventing a new pattern.
--
-- What this is NOT: a password store for anything outside a restaurant's own
-- tablet. No PFD staff login, no admin account, nothing in the CRM. Those
-- remain hashed and unrecoverable.

alter table restaurant_users
  add column if not exists password_current text,
  add column if not exists password_set_at  timestamptz;

comment on column restaurant_users.password_current is
  'The tablet password in plain text, so the CRM can show it again rather than forcing a reset. Service role only - restaurant_users has RLS on with no policies. Deliberate: see migration 026. Never used for PFD staff or admin accounts.';

comment on column restaurant_users.password_set_at is
  'When password_current was last written. A row with a null password predates migration 026 and can only be reset, not revealed.';

-- Revealing is now a third thing that can happen to a login, and the audit
-- table's CHECK has to admit it or every reveal would fail to record - which
-- would quietly turn the audit trail into a partial one, the worst state for
-- it to be in.
alter table restaurant_login_audit
  drop constraint if exists restaurant_login_audit_action_check;

alter table restaurant_login_audit
  add constraint restaurant_login_audit_action_check
  check (action in ('created', 'password_reset', 'password_shown'));
