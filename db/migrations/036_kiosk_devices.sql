-- ============================================================================
-- Migration 036: device binding - a tablet boots straight into its restaurant
-- ============================================================================
--
-- Nick, 2026-09-16: the restaurant touches nothing but the kiosk's Wi-Fi
-- button. A tablet must come up showing its restaurant's orders with
-- nobody typing anything. The app cannot read the hardware serial (Android
-- 10+ keeps that from anything but the device-owner agent), so the shell
-- hands it a reference instead: the serial that Hexnode pushed through
-- managed app configuration, or - when no configuration is present - the
-- install's own ANDROID_ID, prefixed "aid:".
--
-- This table is what the reference resolves against. The CRM owns the
-- assignment (its tablets inventory, D2) and PUSHES it here on assign,
-- unassign and after every MDM sync (POST /api/crm/tablets/bind), so a
-- boot never depends on the CRM answering. A reference the bridge has not
-- been told about is recorded with restaurant_id null so the CRM can list
-- "new tablets seen" and assign them - one click at the office, nothing
-- typed on the tablet.
--
-- Service role only: no policies, RLS on.

create table if not exists kiosk_devices (
  device_ref        text primary key,
  restaurant_id     uuid references restaurants(id) on delete set null,
  -- What the tablet said about itself on its last bootstrap; for the CRM's
  -- "new tablet seen" row. Never identity.
  model             text,
  user_agent        text,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz,
  -- When a session was last minted for it, and how many times ever. Every
  -- bootstrap is logged; a device minting sessions every few seconds is
  -- somebody's script, and the rate limit reads this column.
  last_bootstrap_at timestamptz,
  bootstrap_count   integer not null default 0,
  bound_at          timestamptz,
  bound_by          text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists kiosk_devices_restaurant_idx on kiosk_devices (restaurant_id);
create index if not exists kiosk_devices_unbound_idx on kiosk_devices (last_seen_at desc) where restaurant_id is null;

alter table kiosk_devices enable row level security;

comment on table kiosk_devices is
  'Device reference (managed-config serial, or aid:<ANDROID_ID>) -> restaurant, pushed by the CRM from its tablets inventory. A kiosk bootstraps against this on boot and gets a session for the restaurant''s tablet login. restaurant_id null = seen but not yet assigned. Service role only.';

-- Every bootstrap call, for the per-address rate limit and for "which
-- tablets have been calling in". Small rows; a nightly delete of anything
-- older than a day is a sensible follow-up.
create table if not exists kiosk_bootstrap_log (
  id          bigserial primary key,
  device_ref  text not null,
  ip          text,
  at          timestamptz not null default now()
);

create index if not exists kiosk_bootstrap_log_ip_idx on kiosk_bootstrap_log (ip, at desc);

alter table kiosk_bootstrap_log enable row level security;
