-- ============================================================================
-- Migration 051: the restaurant's weekly statements on its tablet (Matt,
-- 2026-10-24: "the partner portal need to be part of their app that they
-- get with the tablet. they should be able to use same login online to see
-- on computer"; prs-crm docs/briefs/2026-10-24-run-everything-from-the-crm.md
-- §2, phase A1)
-- ============================================================================
--
-- The first page of the partner portal: what Premium owes the restaurant
-- each week, whether it has been paid, and the statement itself. The CRM is
-- the source of every number (its frozen statement snapshot) and pushes a
-- summary per closed week through PUT /api/crm/restaurants/:id/statements,
-- the way it pushes the menu (049). The tablet app only shows what was
-- pushed - no payout maths here, ever (the same rule as send-statement:
-- two systems computing the same money is how they disagree about it).
--
-- One row per restaurant per week, replaced whole on every push, so a
-- payment that lands or a statement that is regenerated simply overwrites.
-- `view_url` / `pdf_url` are the CRM's own no-session statement links (the
-- ones it emails); the app opens them, it never serves the money itself.
-- `payload` keeps the CRM's summary as sent (the figures a restaurant may
-- see - never a commission, rate or fee), so a new line on the page does
-- not need a new column.

create table if not exists restaurant_statements (
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  statement_no    text not null check (char_length(statement_no) between 1 and 40),
  -- paid | pending | held | failed | skipped | none (never allocated to a payment run)
  payment_status  text not null default 'none'
                  check (payment_status in ('paid', 'pending', 'held', 'failed', 'skipped', 'none')),
  paid_at         timestamptz,
  payment_date    date,
  payment_ref     text check (payment_ref is null or char_length(payment_ref) <= 80),
  order_count     integer not null default 0 check (order_count >= 0),
  amount_due_cents integer not null,
  view_url        text check (view_url is null or char_length(view_url) <= 500),
  pdf_url         text check (pdf_url is null or char_length(pdf_url) <= 500),
  generated_at    timestamptz,
  payload         jsonb not null default '{}'::jsonb,
  pushed_at       timestamptz not null default now(),
  primary key (restaurant_id, period_start)
);

create index if not exists restaurant_statements_restaurant_period_idx
  on restaurant_statements (restaurant_id, period_start desc);

alter table restaurant_statements enable row level security;

drop policy if exists restaurant_statements_select on restaurant_statements;
create policy restaurant_statements_select on restaurant_statements
  for select using (is_admin() or belongs_to_restaurant(restaurant_id));

comment on table restaurant_statements is
  'One row per restaurant per closed payout week, as the CRM last pushed it (PUT /api/crm/restaurants/:id/statements). Read by the tablet app''s Money tab. Written only by the CRM; no payout maths lives here.';
