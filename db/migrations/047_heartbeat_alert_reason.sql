-- ============================================================================
-- Migration 047: WHY the alert gate went up, and when it last did
-- ============================================================================
--
-- Workstream AG (Nick, 2026-10-03): the "Turn on order alerts" gate kept
-- coming back on a working tablet at Willie Mae's, and alert_state (037)
-- could only say what the screen showed at the last beat - not why, and not
-- that it had been up five minutes ago and gone again.
--
--   alert_reason         why the screen cannot ring, or why the office should
--                        not trust that it can, at the last beat. Set even
--                        while the orders show: record_failed and
--                        sub_read_failed keep the gate down on purpose.
--   alert_raised_at      when the gate last went up on that screen
--   alert_raised_reason  and why it did
--
-- Reason codes are lib/alert-gate.ts AlertReason; the route drops anything
-- else to null. Nullable, no default, as 030/037: a screen that has not said
-- is null, never a guess. user_agent (024) already says which browser.

alter table dashboard_heartbeats
  add column if not exists alert_reason text
    check (alert_reason in ('perm_default', 'perm_denied', 'sub_absent', 'sub_read_failed', 'record_failed', 'unsupported')),
  add column if not exists alert_raised_at timestamptz,
  add column if not exists alert_raised_reason text
    check (alert_raised_reason in ('perm_default', 'perm_denied', 'sub_absent', 'sub_read_failed', 'record_failed', 'unsupported'));

comment on column dashboard_heartbeats.alert_reason is
  'Why the screen cannot ring (or is unconfirmed) at its last heartbeat: perm_default, perm_denied, sub_absent, sub_read_failed, record_failed, unsupported. Null = nothing wrong, or not reported.';
comment on column dashboard_heartbeats.alert_raised_at is
  'When the alert gate last went up on this screen, as the tablet reported it. Null = never reported.';
comment on column dashboard_heartbeats.alert_raised_reason is
  'The alert_reason at the moment the gate last went up. Null = never reported.';
