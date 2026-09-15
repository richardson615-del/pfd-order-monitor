-- ============================================================================
-- Migration 031: record every scheduled run, so a dead cron is visible
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Nothing in this system records that a scheduled job ran. Gmail polling is
-- inferred from monitored_inboxes.gmail_last_poll_at, which only moves when
-- there is an active inbox to stamp, and the health monitor leaves no trace
-- at all. A cron that stops is therefore indistinguishable from a quiet
-- night - the same ambiguity webhook_receipts was created to remove for
-- inbound orders, one layer up.
--
-- The expensive case is /api/monitor/check itself. Every check in health.ts
-- runs inside it, so if it stops, the alerting stops with it and the silence
-- reads exactly like good health. A monitor cannot report its own death;
-- something on an independent schedule has to. silent_alerted_at is how the
-- job that notices reports it once rather than every two minutes.

create table if not exists cron_runs (
  job               text primary key,
  last_run_at       timestamptz not null default now(),
  -- Separate from last_run_at so "ran and failed" stays distinguishable from
  -- "did not run", which is the distinction the whole table exists for.
  last_ok_at        timestamptz,
  last_detail       text,
  -- Set when a cross-checking job has already reported this one silent.
  -- Cleared whenever the job runs again, so a recovery re-arms the report.
  silent_alerted_at timestamptz
);

alter table cron_runs enable row level security;

comment on table cron_runs is
  'Last run per scheduled job. Answers "did the cron fire?" - including for the health monitor, which cannot answer it about itself.';
