-- ============================================================================
-- Migration 004: allow orders to be marked cancelled
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Zuppler's webhook fires on order CREATE and order CANCEL (confirmed by
-- Jerry Dani, Aug 2026). Without a cancelled state a cancellation either
-- looks like a normal order - printing a ticket for food nobody should make -
-- or has nowhere to be recorded at all.

alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('new','opened','completed','printed','cancelled'));

comment on column orders.status is
  'new | opened | completed | printed | cancelled (cancelled comes from the source system, e.g. a Zuppler cancel event)';
