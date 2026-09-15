-- ============================================================================
-- Migration 032: which clock the restaurant's tablet shows
-- ============================================================================
--
-- The dashboard clock reads the tablet's own device time. That is right
-- exactly as often as the tablet's Android timezone is right, and tablets
-- are provisioned in Nashville and shipped: a screen in eastern Kentucky
-- would show Central time all day, and the "oldest 7:32" beside the
-- waiting count would still be correct while the clock next to it was an
-- hour out. The CRM already knows each account's real zone (derived from
-- its coordinates, because Kentucky splits Central/Eastern along county
-- lines) and pushes it here over the bridge.
--
-- Nullable with no default on purpose. Null means "nothing has told us",
-- and the tablet falls back to device time - which is what it did before
-- this column existed. Defaulting to America/Chicago would put a confident
-- wrong answer on every eastern screen until somebody noticed.
--
-- IANA name, validated at the API (Intl knows the list; Postgres's
-- pg_timezone_names does too, but a CHECK against it would make every
-- restaurant write depend on a view scan). Presentation only: nothing about
-- delivery, chiming or alerting reads this.

alter table restaurants
  add column if not exists timezone text;

comment on column restaurants.timezone is
  'IANA zone the tablet clock shows (e.g. America/New_York). Null = use the device''s own time. Presentation only.';
