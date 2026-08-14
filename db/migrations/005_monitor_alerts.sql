-- ============================================================================
-- Migration 005: remember which problems have already been reported
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- The health check runs on a schedule, so without memory it would re-send the
-- same "printer offline" every few minutes until someone muted the channel -
-- and a muted alert channel is worse than none. One row per distinct problem:
-- notified once when it appears, once more when it clears.

create table if not exists monitor_alerts (
  key            text primary key,          -- stable per problem, from evaluateHealth()
  severity       text not null,
  title          text not null,
  detail         text not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  notified_at    timestamptz,               -- null until the alert is delivered
  resolved_at    timestamptz                -- set when the problem stops being reported
);

create index if not exists monitor_alerts_open_idx
  on monitor_alerts (resolved_at) where resolved_at is null;

comment on table monitor_alerts is
  'Open/closed state for health-check findings, so a recurring problem is reported once rather than every run.';
