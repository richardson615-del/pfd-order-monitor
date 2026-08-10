-- ============================================================================
-- Migration 002: multi-source ingestion + print dispatch
-- Run in Supabase SQL Editor. Safe to run once on the existing database.
-- ============================================================================

-- --- orders: become source-agnostic -----------------------------------------

-- Where the order came from: 'email' (Gmail parser) or 'zuppler' (webhook/API)
alter table orders add column if not exists source text not null default 'email'
  check (source in ('email', 'zuppler'));

-- The source system's own id for the order (Gmail message id, Zuppler order uuid).
-- Used for cross-source de-duplication.
alter table orders add column if not exists external_id text;

-- Raw payload from webhook/API sources (kept for debugging / re-parsing)
alter table orders add column if not exists raw_payload jsonb;

-- Webhook orders have no monitored inbox and no original HTML email
alter table orders alter column inbox_id drop not null;
alter table orders alter column raw_html drop not null;

-- Backfill external_id from gmail_message_id for existing rows
update orders set external_id = gmail_message_id
  where external_id is null and gmail_message_id is not null;

-- One order per (source, external_id). Partial index: rows with no external_id
-- (shouldn't happen going forward) don't block each other.
create unique index if not exists orders_source_external_id_key
  on orders (source, external_id) where external_id is not null;

-- Belt-and-suspenders dedupe across BOTH paths during transition: if the same
-- Zuppler order arrives via webhook AND via the order email, order_number +
-- restaurant should match. We don't hard-constrain this (order numbers could
-- theoretically reset), the ingest function checks it instead.
create index if not exists orders_restaurant_order_number_idx
  on orders (restaurant_id, order_number);

-- --- print_devices: tablets registered to a restaurant ----------------------

create table if not exists print_devices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,                      -- e.g. "Front counter tablet"
  device_key text not null unique,         -- bearer secret the tablet stores
  is_active boolean not null default true,
  last_seen_at timestamptz,
  printer_name text,                       -- paired BT printer, reported by app
  app_version text,
  created_at timestamptz not null default now()
);

-- --- print_jobs: one row per order-to-device print --------------------------

create table if not exists print_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  device_id uuid not null references print_devices(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','claimed','printed','failed')),
  attempts integer not null default 0,
  error text,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  unique (order_id, device_id)             -- an order prints once per device
);

create index if not exists print_jobs_device_status_idx
  on print_jobs (device_id, status);

-- --- RLS --------------------------------------------------------------------
-- Devices authenticate with device_key via API routes using the service role,
-- so no anon access is needed. Restaurant users may view their print jobs.

alter table print_devices enable row level security;
alter table print_jobs enable row level security;

drop policy if exists "restaurant users read own devices" on print_devices;
create policy "restaurant users read own devices" on print_devices
  for select using (
    restaurant_id in (
      select restaurant_id from restaurant_users where auth_user_id = auth.uid()
    )
  );

drop policy if exists "restaurant users read own print jobs" on print_jobs;
create policy "restaurant users read own print jobs" on print_jobs
  for select using (
    device_id in (
      select id from print_devices where restaurant_id in (
        select restaurant_id from restaurant_users where auth_user_id = auth.uid()
      )
    )
  );

-- --- restaurants: link to Zuppler ------------------------------------------
-- The slug Zuppler uses for this restaurant (webhook routing). Falls back to
-- our own slug when they happen to match.
alter table restaurants add column if not exists zuppler_slug text unique;

-- --- Zuppler real integration (per Zuppler's Feb 2026 spec) ------------------
-- Webhook sends order_uuid only; full data fetched from their GraphQL API.
-- Routing key is Zuppler's numeric restaurantId from the order's cart.
alter table restaurants add column if not exists zuppler_restaurant_id text unique;

-- Customer/order notes (gate codes, allergies, instructions) - printed in the
-- NOTE box on the ticket. Zuppler carries these as cart comments/instructions.
alter table orders add column if not exists notes text;
