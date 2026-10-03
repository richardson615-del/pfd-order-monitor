-- ============================================================================
-- Migration 046: which discount / promo code an order used (prs-crm marketing
-- engine, Matt 2026-10-02)
-- ============================================================================
--
-- LoadOrder has always selected carts { discounts { id title promocode } },
-- and Zuppler fills promocode on every discounted order (Matt sampled 25/25,
-- e.g. {"id":2057530,"title":"off your order","promocode":"SHS26"}). Until
-- now only the dollar total (orders.discount) was mapped; the code sat in
-- raw_payload. mapZupplerGraphqlOrder() now also writes it here, and the CRM
-- reads it from /api/crm/customers/orders to link a campaign's code to the
-- orders that used it.
--
-- Shape (jsonb array, snake_case, one element per discount on the order):
--   { discount_id, title, promocode, amount }
-- amount is the order's own totals.discount (dollars, positive) when the
-- order carries exactly ONE discount, else null: LoadOrder selects no
-- per-discount amount, and splitting a total across several discounts would
-- be a guess. [] = a Zuppler order with no discount; NULL = not mapped (email,
-- phone and ezCater orders, and any Zuppler order the backfill
-- (scripts/backfill-discounts.ts, run by a person) has not reached yet).
-- Additive: orders.discount, money_variance, printing and payout are untouched.

alter table orders
  add column if not exists discounts jsonb;

comment on column orders.discounts is
  'Discounts on the order (migration 046): [{discount_id, title, promocode, amount}]. Zuppler only; amount set only when there is exactly one discount. NULL = not mapped.';

-- A write that changes ONLY orders.discounts does not move updated_at.
--
-- updated_at is the tablet's incremental-poll cursor (migration 039): a
-- tablet asks for "rows changed since the last one I saw" (limit 200) and
-- merges them into its live list. The backfill fills discounts on old
-- orders; if each of those writes moved updated_at, every tablet's next poll
-- would pull up to 200 historical orders into today's screen until the
-- hourly full pull reset it. discounts is reporting data the tablet never
-- shows, so a change to it alone is not a change the tablet needs to see.
-- Every other write still stamps updated_at exactly as before.
create or replace function orders_touch_updated_at() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'discounts' - 'updated_at') = (to_jsonb(old) - 'discounts' - 'updated_at') then
    new.updated_at = old.updated_at;
  else
    new.updated_at = now();
  end if;
  return new;
end;
$$;
