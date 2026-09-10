-- ============================================================================
-- Migration 020: the tablet app as a real delivery destination
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Until now the app was not a destination at all. Every ingested order fired
-- a web push to whoever happened to be subscribed, and that was the whole of
-- it: no record that the tablet was owed an alert, nothing to check, and no
-- way to tell a restaurant whose staff are watching a live screen from one
-- whose tablet has been face-down in a drawer since install. A printer that
-- stops printing raises an alert within fifteen minutes. A tablet that stops
-- alerting has been indistinguishable from a quiet night.
--
-- No new tables, for the same reason migration 017 added none: print_jobs is
-- the single record of "a ticket was meant to reach this restaurant", and the
-- monitor and the CRM Printers console both already read that one shape.
-- 'app' is a third delivery alongside 'epson' and 'email', not a second
-- pipeline.
--
-- Note what this migration does NOT do: it does not gate push on the new
-- flag. Push keeps firing exactly as it does today for every restaurant with
-- a subscription, because dozens of them are watching the dashboard right now
-- and a flag defaulting to false would have silenced all of them at once.
-- app_expected says "this restaurant is being ONBOARDED onto the app", which
-- is what earns a delivery row and what the health checks key off.

-- --- restaurants: is the app a destination this site is meant to have? ------
--
-- Deliberately a mirror of printer_expected (migration 014) rather than a new
-- idea. That column exists because mapping the delivery channel brought in
-- hundreds of restaurants -- chains, liquor stores, grocery pickup -- that
-- will never print a ticket, and flagging every one of them buried the real
-- gaps. The app has exactly the same problem and gets exactly the same
-- answer.
alter table restaurants add column if not exists app_expected boolean not null default false;

-- --- print_jobs: 'app' joins 'epson' and 'email' ---------------------------
alter table print_jobs drop constraint if exists print_jobs_delivery_check;
alter table print_jobs add constraint print_jobs_delivery_check
  check (delivery in ('epson', 'email', 'app'));

-- An app job has no device, the same as an email job. The (order_id,
-- device_id) unique index therefore does not constrain it -- Postgres treats
-- each NULL as distinct -- so an order could accumulate two app rows on a
-- retried webhook. This is what actually enforces one alert per order.
create unique index if not exists print_jobs_one_app_per_order
  on print_jobs (order_id) where delivery = 'app';

-- How many subscribed devices the push actually reached. Zero with no error
-- is its own diagnosis and a common one: the app is installed and signed in,
-- but nobody ever tapped "Enable notifications", so there is nothing to send
-- to and nothing failed.
alter table print_jobs add column if not exists delivered_count integer;

-- The monitor looks for app alerts that never went out; keep that cheap, the
-- same way 017 did for email.
create index if not exists print_jobs_app_undelivered_idx
  on print_jobs (queued_at) where delivery = 'app' and sent_at is null;

comment on column restaurants.app_expected is
  'True when this restaurant is meant to be watching orders on the tablet app. Earns a print_jobs row per order and brings the app health checks into play. Does not gate push -- push fires wherever a subscription exists.';
comment on column print_jobs.delivered_count is
  'Subscribed devices a push actually reached. Only meaningful on delivery = app. Zero with no send_error means nobody at the restaurant has notifications turned on.';
