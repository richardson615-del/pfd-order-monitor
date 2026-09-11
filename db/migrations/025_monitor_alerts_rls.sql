-- ============================================================================
-- Migration 025: close the one table that was left open
-- ============================================================================
--
-- Found by the RLS check added alongside the migration runner, not by anyone
-- noticing. monitor_alerts (migration 005) is the only table in this database
-- created without row level security, which makes it readable by anyone
-- holding the anon key - and its rows are the health of the whole pipeline:
-- which restaurants have a printer offline, which inboxes stopped polling,
-- which tickets never printed.
--
-- Safe to close. Only /api/monitor/check touches this table, and it does so
-- through the service role, which bypasses RLS. No policy is missing - the
-- absence of one is the rule, and it denies every client.
--
-- Why it took until now: Supabase's SQL editor warns about this when a table
-- is created by hand in the dashboard, and every other table here was. This
-- one predates that habit. The check now runs on every commit instead of
-- depending on where a statement happened to be typed.

alter table monitor_alerts enable row level security;

comment on table monitor_alerts is
  'Open and resolved health issues, written only by /api/monitor/check through the service role. RLS on with no policies: no client has any business reading the pipeline health of every restaurant at once.';
