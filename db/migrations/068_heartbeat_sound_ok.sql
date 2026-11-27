-- ============================================================================
-- Migration 068: whether the order screen's SOUND can play
-- ============================================================================
--
-- HP1 (Tickets #1909, #1078, Nick 2026-11-25): a restaurant running the order
-- screen in Chrome on its own tablet - not in the Hexnode shell - said new
-- orders did not ring. The heartbeat could already say whether the screen
-- holds a push subscription (push_subscribed, 030) and why the alert gate is
-- up (alert_state 037, alert_reason 047). It could not say the other half:
-- whether the browser will play the chime at all. A browser will not start
-- audio until somebody touches the page, and can switch it off again later;
-- the screen now shows a "Tap to turn on order sound" bar when that happens,
-- and this column is how the office sees it too.
--
--   true   the screen's audio is running - the chime will sound
--   false  the screen is showing the "Tap to turn on order sound" bar
--   null   it has not said (an older screen, or not checked yet)
--
-- A new column, not a new alert_state value: alert_state is the push
-- permission gate, the two are independent (a tablet can be "blocked" AND
-- silent), and the CRM matches alert_state by exact value. Nullable, no
-- default, as 030/037/047: a screen that has not said is null, never a guess.
-- Additive: nothing that reads dashboard_heartbeats today selects it.

alter table dashboard_heartbeats
  add column if not exists sound_ok boolean;

comment on column dashboard_heartbeats.sound_ok is
  'Whether the order screen''s audio could play at its last heartbeat: true = the chime will sound; false = the browser has audio off and the screen is showing "Tap to turn on order sound"; null = not reported.';
