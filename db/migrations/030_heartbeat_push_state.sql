-- ============================================================================
-- Migration 030: does the open tablet actually have alerts on?
-- ============================================================================
--
-- dashboard_heartbeats (migration 024) answers "is a signed-in screen open for
-- this restaurant". It cannot answer the question that actually predicts a
-- missed order: whether that screen will RING.
--
-- Those come apart more often than they sound like they should. A tablet can
-- be open, signed in, beating every two minutes, showing a green screen - and
-- hold no push subscription at all, because somebody cleared the app's
-- storage, or reinstalled it, or the browser retired the endpoint. Health
-- already warns when a restaurant has ZERO subscriptions
-- (restaurant_no_app_device), but that is a fact about the restaurant; this is
-- a fact about the device in front of somebody, and it is the one that tells
-- you which tablet to go and touch.
--
-- Nullable with no default on purpose. Existing rows genuinely do not know -
-- they were written before anything reported it - and defaulting them to
-- false would invent a fleet-wide alarm out of missing data, while defaulting
-- them to true would state the reassuring thing on no evidence. Null means
-- "this screen has not told us yet", which is what is true.

alter table dashboard_heartbeats
  add column if not exists push_subscribed boolean;

comment on column dashboard_heartbeats.push_subscribed is
  'Whether the dashboard that sent this heartbeat held a push subscription at the time. Null means it has not reported (rows written before migration 030, or an older client). A screen that is open with this false is the case that looks healthy and will still miss an order.';
