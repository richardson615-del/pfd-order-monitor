-- ============================================================================
-- Migration 013: smart footer engine (v1)
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Footers become per-order rather than a static stamp. Two rules shape this:
--
-- 1. Footers resolve at INGEST, not at print. The print path must not run
--    queries while a cook waits, and a ticket reprinted tomorrow must say the
--    same thing it said today - a footer computed at print time would quietly
--    change under a reprint.
-- 2. footer_engine is orthogonal to ticket_footer_mode. The mode decides how
--    the footer is DRAWN (qr / text / image); the engine decides where its
--    CONTENT comes from (static columns, or a template).

alter table restaurants add column if not exists footer_engine text
  not null default 'static';
alter table restaurants drop constraint if exists restaurants_footer_engine_check;
alter table restaurants add constraint restaurants_footer_engine_check
  check (footer_engine in ('static', 'dynamic'));

alter table restaurants add column if not exists footer_template_id text;
alter table restaurants add column if not exists footer_template_config jsonb
  not null default '{}'::jsonb;

-- Atomic, monotonic, per restaurant. count(*) over orders races with itself
-- and gets slower every week; a counter cannot do either.
alter table restaurants add column if not exists order_counter bigint
  not null default 0;

-- The footer this order will print, decided once at ingest.
alter table orders add column if not exists footer_resolved jsonb;

-- --- append-only event log -------------------------------------------------
create table if not exists footer_events (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  order_id      uuid references orders(id) on delete set null,
  template_id   text not null,
  kind          text not null
    check (kind in ('rendered','qr_scanned','prize_won','prize_redeemed','coupon_redeemed')),
  token         text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists footer_events_restaurant_idx
  on footer_events (restaurant_id, created_at desc);
create index if not exists footer_events_kind_idx
  on footer_events (template_id, kind, created_at desc);

-- One winner per milestone, enforced by the database rather than by timing.
-- Unused in v1 (milestone ships disabled) but the constraint belongs with the
-- table, not with the feature flag.
create unique index if not exists footer_events_milestone_unique
  on footer_events (restaurant_id, template_id, (payload->>'milestone'))
  where kind = 'prize_won' and payload ? 'milestone';

-- --- tokens: the only public surface ---------------------------------------
create table if not exists footer_tokens (
  token         text primary key,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  order_id      uuid references orders(id) on delete set null,
  template_id   text not null,
  payload       jsonb not null default '{}'::jsonb,
  hits          integer not null default 0,
  first_hit_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists footer_tokens_restaurant_idx
  on footer_tokens (restaurant_id, created_at desc);

alter table footer_events enable row level security;
alter table footer_tokens enable row level security;

-- --- atomic helpers --------------------------------------------------------

-- Next order number for a restaurant. UPDATE ... RETURNING is atomic under
-- concurrency; two simultaneous orders get two different numbers.
create or replace function next_restaurant_order_number(rid uuid)
returns bigint
language sql
as $$
  update restaurants
     set order_counter = order_counter + 1
   where id = rid
  returning order_counter;
$$;

-- Rate limiting with shared state, since serverless has none of its own.
-- Returns the hit count AFTER incrementing; the caller refuses above the cap.
create or replace function bump_footer_token(t text)
returns integer
language sql
as $$
  update footer_tokens
     set hits = hits + 1,
         first_hit_at = coalesce(first_hit_at, now())
   where token = t
  returning hits;
$$;

comment on column restaurants.footer_engine is
  'static = use the ticket_footer_* columns; dynamic = render footer_template_id.';
comment on column orders.footer_resolved is
  'Footer decided at ingest: {text, url, template_id, token, payload}. Printing reads this and computes nothing.';
