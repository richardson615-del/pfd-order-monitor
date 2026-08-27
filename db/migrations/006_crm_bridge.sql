-- ============================================================================
-- Migration 006: let the CRM queue a test ticket
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- print_jobs.order_id is NOT NULL, so a test print needs an order row to hang
-- off. Rather than invent a fake email or Zuppler order - which would then be
-- indistinguishable from a real one in the dashboard, in reconciliation, and
-- in anything we later write against orders - test prints get their own source.
--
-- One value in a check constraint, and every existing query that cares can say
-- source <> 'test'. No new column, and the (source, external_id) unique index
-- keeps working unchanged.

alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check
  check (source in ('email', 'zuppler', 'test'));

comment on column orders.source is
  'Where the order came from: email ingest, Zuppler API, or a CRM-issued test print.';
