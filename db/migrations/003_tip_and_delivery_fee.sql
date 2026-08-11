-- ============================================================================
-- Migration 003: store tip and delivery fee as first-class columns
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Zuppler splits an order's money into subtotal / delivery / service / tax /
-- tip / total. We were only storing subtotal, service and tax, so the stored
-- columns did not reconcile to customer_total - the delivery fee and the tip
-- were only recoverable from the raw_payload JSON.
--
-- The tip matters operationally: it is the DRIVER's money, and it needs to be
-- visible on the printed ticket and the dashboard, not buried in a blob.
--
-- Existing rows keep NULL (unknown) rather than 0, so "no tip recorded" stays
-- distinguishable from "tipped nothing".

alter table orders add column if not exists tip numeric(10,2);
alter table orders add column if not exists delivery_fee numeric(10,2);

comment on column orders.tip is
  'Customer tip. Driver''s money - shown on the ticket. Included in customer_total.';
comment on column orders.delivery_fee is
  'Delivery charge, separate from service_fee. Included in customer_total.';
