-- ============================================================================
-- Migration 016: capture every money field Zuppler sends
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Zuppler returns nine keys in totals: subtotal, tax, service, delivery, tip,
-- total, discount, hidden, includedTax. Six had columns. Discount existed only
-- as prose in notes ("Discount applied: $6.79"), written for the kitchen
-- ticket rather than for accounting - so 17 of 56 stored orders did not
-- reconcile, every one of them by exactly the discount.
--
-- hidden and includedTax are zero in every order seen so far. They are stored
-- anyway: the day a tax-inclusive restaurant onboards is the wrong day to
-- discover the field was dropped at ingest and the history cannot be rebuilt.
--
-- channel_id was recoverable only by digging into raw_payload. Accounting will
-- group by it, and a JSON path on every row makes raw_payload load-bearing.

alter table orders add column if not exists discount     numeric(10,2);
alter table orders add column if not exists included_tax numeric(10,2);
alter table orders add column if not exists hidden_fee   numeric(10,2);
alter table orders add column if not exists channel_id   text;

-- The tripwire. total - (subtotal + tax + service + delivery + tip - discount)
-- should be zero. Anything else means a money field we are not capturing -
-- a tenth key, a new fee, a changed sign - and it must be visible before it
-- reaches a statement someone disputes.
alter table orders add column if not exists money_variance numeric(10,2);

create index if not exists orders_money_variance_idx
  on orders (received_at desc) where money_variance is not null and money_variance <> 0;

create index if not exists orders_channel_idx on orders (channel_id, received_at desc);

comment on column orders.discount is
  'Zuppler totals.discount. Subtracted when reconciling; absent from the sum of the other components.';
comment on column orders.hidden_fee is
  'Zuppler totals.hidden. Always 0 so far - stored so history exists if that changes.';
comment on column orders.included_tax is
  'Zuppler totals.includedTax - tax already inside subtotal. NOT added when reconciling.';
comment on column orders.money_variance is
  'total minus the sum of captured components. Non-zero means a money field is not being captured.';
