-- ============================================================================
-- PFD Order Monitor - Supabase schema
-- Run this in Supabase SQL Editor (Project -> SQL Editor -> New query)
-- ============================================================================

-- Restaurants ("tenants") that PFD serves
create table if not exists restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Links a Supabase Auth user to a restaurant (a restaurant can have
-- more than one login, e.g. owner + manager)
create table if not exists restaurant_users (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  unique (restaurant_id, auth_user_id)
);

-- PFD staff who can access /admin (add restaurants, assign inboxes)
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The inbox PFD monitors for a given restaurant. MVP = Gmail via OAuth.
-- IMAP columns are included now so the later IMAP fallback doesn't need a migration.
create table if not exists monitored_inboxes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  provider text not null default 'gmail' check (provider in ('gmail','imap')),
  email_address text not null,

  -- Gmail OAuth (MVP)
  gmail_refresh_token text,
  gmail_access_token text,
  gmail_token_expiry timestamptz,
  gmail_history_id text,          -- last processed Gmail historyId (incremental sync)
  gmail_last_poll_at timestamptz,

  -- IMAP (future fallback) - password should be stored via Supabase Vault /
  -- an encrypted secret manager, not plain text, before this is used for real.
  imap_host text,
  imap_port integer,
  imap_username text,
  imap_password_encrypted text,

  -- Order-detection rules
  sender_filter text not null default 'noreply@mail.datadreamers.us',
  subject_pattern text not null default '^Order\s+(\d+)',

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, email_address)
);

-- One row per parsed order email
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  inbox_id uuid not null references monitored_inboxes(id) on delete cascade,

  gmail_message_id text unique,   -- Gmail's message id, used for de-duplication
  order_number text not null,
  ticket_restaurant_name text,    -- restaurant/location name as printed on the ticket
  order_type text,                -- 'pickup' | 'delivery' | null if unknown
  due_time timestamptz,

  customer_name text,
  customer_phone text,
  customer_address text,

  items jsonb not null default '[]'::jsonb,   -- [{ name, quantity, price, modifiers: [] }]
  items_total numeric(10,2),
  tax numeric(10,2),
  service_fee numeric(10,2),
  customer_total numeric(10,2),
  payment_type text,

  raw_html text not null,         -- original HTML ticket body, rendered in a sandboxed viewer

  status text not null default 'new' check (status in ('new','opened','completed','printed')),

  received_at timestamptz not null default now(),
  opened_at timestamptz,
  completed_at timestamptz,
  printed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_orders_restaurant_status on orders(restaurant_id, status);
create index if not exists idx_orders_received_at on orders(received_at desc);

-- Web push subscriptions, one per browser/device the restaurant installed the PWA on
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table restaurants enable row level security;
alter table restaurant_users enable row level security;
alter table admins enable row level security;
alter table monitored_inboxes enable row level security;
alter table orders enable row level security;
alter table push_subscriptions enable row level security;

-- Helper: is the current auth user an admin?
create or replace function is_admin() returns boolean as $$
  select exists (select 1 from admins where auth_user_id = auth.uid());
$$ language sql stable security definer;

-- Helper: does the current auth user belong to a given restaurant?
create or replace function belongs_to_restaurant(r_id uuid) returns boolean as $$
  select exists (
    select 1 from restaurant_users
    where restaurant_id = r_id and auth_user_id = auth.uid()
  );
$$ language sql stable security definer;

-- Restaurants: members can see their own restaurant, admins see all
create policy "restaurants_select" on restaurants for select
  using (is_admin() or belongs_to_restaurant(id));
create policy "restaurants_admin_write" on restaurants for all
  using (is_admin()) with check (is_admin());

-- restaurant_users: visible to admins and to members of the same restaurant
create policy "restaurant_users_select" on restaurant_users for select
  using (is_admin() or belongs_to_restaurant(restaurant_id));
create policy "restaurant_users_admin_write" on restaurant_users for all
  using (is_admin()) with check (is_admin());

-- admins table: only admins can read/write it
create policy "admins_select" on admins for select using (is_admin());
create policy "admins_write" on admins for all using (is_admin()) with check (is_admin());

-- monitored_inboxes: restaurant members can view (not edit) their own inbox row;
-- only admins can create/update/delete (so tokens are managed centrally by PFD)
create policy "inboxes_select" on monitored_inboxes for select
  using (is_admin() or belongs_to_restaurant(restaurant_id));
create policy "inboxes_admin_write" on monitored_inboxes for all
  using (is_admin()) with check (is_admin());

-- orders: restaurant members can read and update (status changes) their own orders
create policy "orders_select" on orders for select
  using (is_admin() or belongs_to_restaurant(restaurant_id));
create policy "orders_update" on orders for update
  using (is_admin() or belongs_to_restaurant(restaurant_id));
create policy "orders_admin_insert" on orders for insert
  with check (is_admin());

-- push_subscriptions: users manage their own subscriptions
create policy "push_select" on push_subscriptions for select
  using (is_admin() or auth_user_id = auth.uid());
create policy "push_insert" on push_subscriptions for insert
  with check (auth_user_id = auth.uid());
create policy "push_delete" on push_subscriptions for delete
  using (auth_user_id = auth.uid());

-- ============================================================================
-- Realtime: let the dashboard subscribe to new/changed orders
-- ============================================================================
alter publication supabase_realtime add table orders;
