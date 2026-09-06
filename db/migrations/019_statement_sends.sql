-- ============================================================================
-- Migration 019: audit + idempotency for restaurant statement emails
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- A statement is a financial document addressed to a restaurant owner. Two
-- properties that a ticket does not need:
--
-- 1. Idempotency. A duplicate ticket is a confusing second piece of paper. A
--    duplicate statement is two documents about the same money, and if the CRM
--    retries after a timeout the owner has no way to tell which is current.
--
-- 2. An audit trail. "Which figures went to whom, and when" is the question
--    asked when a payout is disputed, and it cannot be answered from Gmail's
--    Sent folder alone once there are dozens of restaurants.

create table if not exists statement_sends (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text,
  to_address      text not null,
  subject         text not null,
  restaurant_id   uuid references restaurants(id) on delete set null,
  restaurant_name text,
  period_start    date,
  period_end      date,
  -- Size rather than content: the statement itself belongs in the CRM, and a
  -- copy here would be a second source of truth for someone's payout.
  html_bytes      integer,
  message_id      text,
  status          text not null check (status in ('sent', 'failed', 'dry_run')),
  error           text,
  created_at      timestamptz not null default now()
);

-- Idempotency. Partial, so rows without a key are unconstrained.
create unique index if not exists statement_sends_idempotency_key
  on statement_sends (idempotency_key) where idempotency_key is not null;

create index if not exists statement_sends_restaurant_idx
  on statement_sends (restaurant_id, created_at desc);

alter table statement_sends enable row level security;

comment on table statement_sends is
  'Every statement email attempt. Answers "which figures went to whom, and when" when a payout is disputed.';
comment on column statement_sends.html_bytes is
  'Size only. The statement content lives in the CRM; a copy here would be a second source of truth for a payout.';
