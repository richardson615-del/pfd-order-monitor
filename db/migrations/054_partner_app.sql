-- 054: PFD Partner, the restaurant owner's phone app (PA1, 2026-10-26).
--
-- Matt: "any restaurant owner can put on their phone and login ... send us
-- trouble tickets and communicate with dispatch". The app signs in as the
-- restaurant's own login (by a code texted to an owner's cell, or by
-- username and password) and then uses the tablet's /api/dashboard routes
-- with a Bearer token. Brief: prs-crm docs/briefs/2026-10-26-pfd-partner-app.md.
--
-- All three tables are service-role only: RLS on, no policies.

-- Owner cells the CRM put on file; only these may get a sign-in code.
create table if not exists app_owner_phones (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  phone text not null check (phone ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  name text check (name is null or char_length(name) <= 80),
  added_by text check (added_by is null or char_length(added_by) <= 120),
  created_at timestamptz not null default now(),
  unique (restaurant_id, phone)
);
create index if not exists app_owner_phones_phone_idx on app_owner_phones (phone);
alter table app_owner_phones enable row level security;

-- One row per code texted. The code itself is never stored: code_hash is
-- sha256(secret | phone | code). Ten minutes, single use, five tries.
create table if not exists app_login_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists app_login_codes_phone_idx on app_login_codes (phone, created_at desc);
alter table app_login_codes enable row level security;

-- Expo push tokens of phones signed in to the app, per restaurant.
create table if not exists app_push_tokens (
  token text primary key check (char_length(token) <= 255),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  platform text check (platform is null or platform in ('ios', 'android')),
  owner_name text check (owner_name is null or char_length(owner_name) <= 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists app_push_tokens_restaurant_idx on app_push_tokens (restaurant_id);
alter table app_push_tokens enable row level security;
