-- ============================================================================
-- Migration 037: WHY a tablet's alerts are off, not just that they are
-- ============================================================================
--
-- push_subscribed (030) says whether the open screen will ring. It cannot
-- say why not, and on a managed kiosk the why is the whole story:
--
--   ask          the screen is waiting for its one tap (first run)
--   blocked      the notification permission is DENIED. On a Hexnode kiosk
--                that permission is granted by policy (App Permissions ->
--                Premium -> Send push notifications: Allow), so blocked
--                means the policy is missing or was changed. The tablet has
--                no Settings app to open; only the office can fix it, from
--                the Hexnode console. Nick, 2026-09-16.
--   unsupported  no Push API - a plain browser, not the shell
--   hidden       alerts are on (push_subscribed says whether the record held)
--
-- Nullable, no default, same reasoning as 030: a screen that has not said is
-- null, never "blocked". The CHECK is the set the dashboard's gate can be in
-- (lib/alert-gate.ts AlertGateState); the route drops anything else to null.

alter table dashboard_heartbeats
  add column if not exists alert_state text
    check (alert_state in ('hidden', 'ask', 'blocked', 'unsupported'));

comment on column dashboard_heartbeats.alert_state is
  'The alert gate state the dashboard reported on its last heartbeat: hidden (alerts on), ask (waiting for the one tap), blocked (notification permission denied - on a Hexnode kiosk, the notification policy is missing; only the office can fix it), unsupported (no Push API). Null = not reported.';
