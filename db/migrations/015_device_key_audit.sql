-- ============================================================================
-- Migration 015: audit device key reveals and reissues
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- A device key is a credential. It is stored in plaintext because the printer
-- presents it verbatim on every poll and cannot hash it - so "shown once" was
-- always a UI convention rather than a security property, and pretending
-- otherwise just meant the only way back to a key was a hand-written SQL
-- query against production with no record that it happened.
--
-- A gated, logged reveal is the honest version of what was already true.

create table if not exists device_key_audit (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid not null references print_devices(id) on delete cascade,
  action     text not null check (action in ('revealed', 'reissued')),
  -- Who asked. The bridge only ever sees a shared key, so the CRM has to say
  -- which of its users this was; null means it did not.
  actor      text,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists device_key_audit_device_idx
  on device_key_audit (device_id, created_at desc);

alter table device_key_audit enable row level security;

comment on table device_key_audit is
  'Every reveal or reissue of a printer device key. Append-only.';
