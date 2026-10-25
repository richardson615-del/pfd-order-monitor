-- 053: Uber Eats Marketplace orders (2026-10-25).
--
-- Matt: "i want to build everything kitchenhub has". The CRM is the Uber
-- Eats integration: Uber sends it each new order, and it relays the order
-- here through POST /api/crm/orders with source 'ubereats' - the same path
-- a phone order takes, so printing, the tablet and the AEM email are
-- decided by orderDestinations() as for any other order.
--
--   - orders.source admits 'ubereats'. Idempotent on (source, external_id),
--     where external_id is Uber's order id.
--   - The ticket says "PAID - UBER EATS": the customer paid Uber, and the
--     kitchen never collects (lib/phone-order.ts tenderLine).
--   - The CRM cancels the order here when Uber cancels it
--     (lib/crm-orders.ts cancelRefusal).

alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check
  check (source in ('email', 'zuppler', 'test', 'phone', 'ezcater', 'ubereats'));
