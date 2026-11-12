-- 061: An advance order stays off the restaurant's tablet and Partner app until it goes to the kitchen.
--
-- Kayla, 2026-11-12: Larry's tablet showed advance orders before dispatch sent them. The hold (053/#155/#156)
-- only held the paper; the tablet listed the order and the app alert went out at ingest.
--
-- kitchen_hold_until is set at ingest to the release time of a held order (lib/advance-order.ts) and cleared when
-- the order goes to the kitchen (the minute sweep or dispatch's Send to kitchen), which also sends the tablet and
-- app alert. Null = not held, which is every order before this migration. The tablet treats a time already past as
-- not held, so a sweep that never runs can delay an order's chime but never hide the order past its release time.
alter table orders add column if not exists kitchen_hold_until timestamptz;

-- The sweep and the CRM look up held orders; few rows ever have it set.
create index if not exists orders_kitchen_hold_until_idx on orders (kitchen_hold_until) where kitchen_hold_until is not null;
