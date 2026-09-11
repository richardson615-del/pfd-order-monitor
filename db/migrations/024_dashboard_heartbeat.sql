-- ============================================================================
-- Migration 024: is a tablet actually showing the dashboard?
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- The last silent failure left in the tablet path.
--
-- A push subscription survives being signed out. It belongs to the browser's
-- service worker, not to the session - so a tablet whose session has ended
-- sits on a login screen while push keeps reporting delivered, the health
-- checks stay green, and nobody finds out until a restaurant says orders
-- stopped appearing. Every other way this could fail now raises something;
-- this one looked perfectly healthy.
--
-- So the dashboard says "I am open and signed in" every couple of minutes,
-- and the monitor can notice when it stops.
--
-- One row per restaurant, upserted, rather than a log: the only question
-- anyone asks of this is "when was a screen last up", and keeping a row per
-- beat would write thousands of rows a day to answer it.

create table if not exists dashboard_heartbeats (
  restaurant_id uuid primary key references restaurants(id) on delete cascade,
  last_seen_at  timestamptz not null default now(),
  -- Which device, roughly. Not identity - two tablets at one restaurant share
  -- a row (see below) - but enough to tell an Android tablet from somebody's
  -- laptop when working out what is actually on the wall.
  user_agent    text
);

create index if not exists dashboard_heartbeats_seen_idx
  on dashboard_heartbeats (last_seen_at);

-- RLS on, and deliberately NO policies.
--
-- Nothing legitimate touches this table with an anon or authenticated key:
-- the heartbeat is written by the endpoint through the service role, and the
-- health snapshot reads it the same way, and the service role bypasses RLS.
-- So no policy is missing - the absence of one is the rule, and it denies
-- every client.
--
-- Without this line the table is readable by anyone holding the anon key,
-- which for a row saying which restaurants are open and what device is on
-- their wall is more than nothing. Supabase's SQL editor flags exactly this,
-- and it was right to.
alter table dashboard_heartbeats enable row level security;

comment on table dashboard_heartbeats is
  'When a signed-in dashboard was last open for this restaurant. One row per restaurant, not per device: with two tablets, one being alive masks the other. Deliberate for now - the failure worth catching is nobody watching at all, and a per-device model needs a device identity the browser does not have.';
comment on column dashboard_heartbeats.last_seen_at is
  'Updated by the dashboard every couple of minutes while it is open and signed in. Staleness only means something alongside recent orders - a closed restaurant has its tablet off, and that is not a fault.';
