-- ============================================================================
-- Migration 023: record who created or reset a restaurant login
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Restaurant logins can now be created and reset from the CRM, which means a
-- password can be produced by somebody who is not sitting in this app's own
-- admin panel. Migration 015 made the same judgement about printer device
-- keys: a credential that can be read is a credential worth recording who
-- read, and there is no way to do it silently.
--
-- The bridge authenticates with one shared key and therefore cannot know WHO
-- asked. The CRM passes an actor, and an absent one is recorded as null
-- rather than guessed at - the same contract device_key_audit uses.
--
-- Deliberately records no password, not even hashed. The point of the row is
-- that a change happened and who made it; storing the value would turn an
-- audit trail into a second place credentials live.

create table if not exists restaurant_login_audit (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants(id) on delete set null,
  username      text not null,
  action        text not null check (action in ('created', 'password_reset')),
  -- Who asked, as reported by the caller. Null means nobody was named.
  actor         text,
  note          text,
  created_at    timestamptz not null default now()
);

-- "What happened to this restaurant's logins" is the question this answers.
create index if not exists restaurant_login_audit_restaurant_idx
  on restaurant_login_audit (restaurant_id, created_at desc);

-- restaurant_id is nullable and ON DELETE SET NULL on purpose: a deleted
-- restaurant must not take its audit history with it. The username stays on
-- the row, so the record still says what was done.
alter table restaurant_login_audit enable row level security;

comment on table restaurant_login_audit is
  'Who created or reset a restaurant login, and when. Never the password itself - the row records that a change happened, not the credential. Mirrors device_key_audit (migration 015) for the same reason.';
