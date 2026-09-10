-- ============================================================================
-- Migration 021: an order is acknowledged when someone accepts it
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- The alert used to stop when an order was OPENED, and opening happened on its
-- own the moment anyone tapped the order - including a passing glance, a
-- mis-tap, or a cook checking what came in while their hands were full. The
-- kitchen had not agreed to make anything; the tablet just went quiet.
--
-- Accepting is a deliberate act: somebody looked at the ticket and said yes.
-- The chime now continues until that happens, which is the whole point of a
-- tablet on a wall.
--
-- A timestamp, not another value in orders.status. Migration 018 has the
-- reasoning at length: status was made to carry two meanings at once, they
-- diverged the moment an order was cancelled after printing, and a single
-- string could not express both. 'printed', 'completed' and 'opened' are
-- already not a sequence; adding 'accepted' would deepen that rather than fix
-- it. Acceptance is a fact with a time, and it composes with all of them.

alter table orders add column if not exists accepted_at timestamptz;

-- Everything that already exists was handled under the old rules, where
-- opening silenced the alert. Without this backfill every order in the
-- history becomes "not yet accepted" the moment this ships, and the tablet
-- beeps continuously for two hundred orders nobody can do anything about.
--
-- The cost is that a genuinely fresh order in the seconds around the deploy
-- is marked accepted without anyone having done so. That is the right way
-- round: one order silenced against every order in the history beeping.
update orders
   set accepted_at = coalesce(opened_at, printed_at, completed_at, cancelled_at, received_at)
 where accepted_at is null;

-- The dashboard asks "is anything still waiting?" on every render.
create index if not exists orders_unaccepted_idx
  on orders (restaurant_id)
  where accepted_at is null;

comment on column orders.accepted_at is
  'When someone at the restaurant explicitly accepted the order. Null means the alert is still sounding. Deliberately separate from opened_at: opening is a tap, accepting is an agreement to make the food.';
