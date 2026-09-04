-- ============================================================================
-- Migration 017: email delivery leg (Automatic Email Manager bridge)
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Numbered 017, not 016: 016_accounting_capture landed on 2026-09-02, before
-- this spec was written.
--
-- Some restaurants still print through Automatic Email Manager on a local PC.
-- For those, the ticket goes out as email instead of an Epson job - same
-- rendered text, so the kitchen sees the standard PFD ticket.
--
-- No new tables, deliberately. print_jobs stays the single record of "a ticket
-- was meant to reach this restaurant", so the monitor and the CRM Printers
-- console keep working on one shape instead of two.

alter table restaurants add column if not exists print_method text
  not null default 'printer';
alter table restaurants drop constraint if exists restaurants_print_method_check;
alter table restaurants add constraint restaurants_print_method_check
  check (print_method in ('printer', 'email'));

alter table restaurants add column if not exists ticket_email_to text;

alter table print_jobs add column if not exists delivery text
  not null default 'epson';
alter table print_jobs drop constraint if exists print_jobs_delivery_check;
alter table print_jobs add constraint print_jobs_delivery_check
  check (delivery in ('epson', 'email'));

alter table print_jobs add column if not exists sent_at    timestamptz;
alter table print_jobs add column if not exists send_error text;

-- An email job has no device. device_id was NOT NULL with an FK to
-- print_devices, which the spec did not account for - the alternative was a
-- fake "device" row per email restaurant, which would then appear in the
-- Printers console, be counted by the monitor, and show as permanently
-- offline. Nullable is the honest shape.
alter table print_jobs alter column device_id drop not null;

-- The (order_id, device_id) unique index does not constrain email jobs,
-- because Postgres treats each NULL as distinct - so an order could queue two
-- emails. This is what actually enforces "never send twice for one order".
create unique index if not exists print_jobs_one_email_per_order
  on print_jobs (order_id) where delivery = 'email';

-- The monitor looks for email jobs that never sent; this keeps that cheap.
create index if not exists print_jobs_email_unsent_idx
  on print_jobs (queued_at) where delivery = 'email' and sent_at is null;

comment on column restaurants.print_method is
  'printer = Epson Server Direct Print; email = ticket emailed to ticket_email_to for AEM to print.';
comment on column restaurants.ticket_email_to is
  'The AEM-watched inbox at the restaurant. Required when print_method = email.';
comment on column print_jobs.delivery is
  'How this ticket was meant to reach the restaurant. Epson jobs are claimed by a polling printer; email jobs are sent once.';
comment on column print_jobs.sent_at is
  'When the email actually left. Null on an email job older than a few minutes means it never did.';
