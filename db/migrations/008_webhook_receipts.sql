-- ============================================================================
-- Migration 008: record every webhook receipt, accepted or not
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- On 2026-08-27 two POSTs arrived at /api/ingest/zuppler and produced no
-- orders. Which of 401, 400 or 422 they were could not be determined: the
-- rejecting paths return a status and log nothing, so a live order being
-- dropped left exactly as much evidence as nothing happening at all.
--
-- That ambiguity is the expensive one on this project. "Zuppler has not
-- wired the channel yet" and "Zuppler is sending and we are turning it away"
-- look identical from the outside, and we have already lost a day to a token
-- mismatch that presented as silence.
--
-- Written BEFORE authentication is checked, on purpose - a rejected receipt
-- is the one most worth having. raw_body is truncated by the writer, since
-- this endpoint is necessarily open to the internet.

create table if not exists webhook_receipts (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  source        text not null default 'zuppler',
  -- What we did with it: unauthorized | invalid_json | no_order_uuid |
  -- not_found | ingest_error | unmapped | created | duplicate | updated |
  -- cancelled
  status        text not null,
  http_status   integer,
  order_uuid    text,
  order_id      uuid references orders(id) on delete set null,
  detail        text,
  raw_body      text,
  user_agent    text
);

create index if not exists webhook_receipts_received_idx
  on webhook_receipts (received_at desc);

create index if not exists webhook_receipts_status_idx
  on webhook_receipts (status, received_at desc);

alter table webhook_receipts enable row level security;

comment on table webhook_receipts is
  'Every inbound order webhook, including ones rejected before authentication. Answers "did anything arrive?" without needing the log window to still contain it.';
