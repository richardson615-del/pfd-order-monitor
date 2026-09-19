-- ============================================================================
-- Migration 042: phone orders taken in the CRM (Workstream O1, Nick 2026-09-18)
-- ============================================================================
--
-- A dispatcher answers the phone, builds the order in the CRM, charges the
-- card there, and POSTs it to /api/crm/orders. It is stored like any other
-- order and reaches the restaurant through the same paper / tablet / email
-- path a Zuppler order does. Two things the schema did not allow for:
--
--   1. orders.source admitted 'email', 'zuppler' and 'test' (migration 006).
--      'phone' is a fourth, real source - not a test - so the constraint is
--      widened rather than the order disguised as one of the others.
--
--   2. A card surcharge. Phone orders paid by card carry a separate line
--      (3% by default, per the brief) that is PFD's revenue, not the
--      restaurant's sales and not a service fee. It gets its own column so
--      payouts can exclude it, and money_variance counts it so a surcharged
--      order still reconciles to the total the customer paid.
--
-- Nothing about Zuppler or email orders changes: their surcharge stays null.

alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check
  check (source in ('email', 'zuppler', 'test', 'phone'));

alter table orders
  add column if not exists surcharge numeric(10, 2);

comment on column orders.surcharge is
  'Card surcharge on a phone order (O1). PFD revenue, not restaurant sales; part of the component sum in money_variance. Null for every other source.';
