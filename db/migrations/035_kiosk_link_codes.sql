-- ============================================================================
-- Migration 035: link codes - a tablet with no session pairs from the CRM
-- ============================================================================
--
-- The restaurant's only setup step is Wi-Fi (Nick, 2026-09-16). Nobody at a
-- store types a username or a password on a kitchen tablet ever again. So
-- when a tablet has connectivity but no valid session - never bound, or the
-- session was lost - it shows a six-digit code and says "call Premium".
-- Somebody in the office enters the code in the CRM against a restaurant,
-- and the bridge mints a session for that device.
--
-- One row per code. The code is short enough to read over the phone and
-- lives thirty minutes; it is bound to the device that asked for it, so a
-- code overheard in a kitchen cannot be redeemed on a different tablet.
-- token_hash is a Supabase magic-link hash generated server-side when the
-- office links the code; the device that owns the code collects it exactly
-- once (consumed_at) and verifies it in the browser, which is what creates
-- the session. It is never shown to anyone.
--
-- Service role only: no policies, RLS on. The two public kiosk routes go
-- through supabaseAdmin() and check the device id themselves.

create table if not exists kiosk_link_codes (
  code            text primary key,
  -- An opaque random id the tablet generates once and keeps in localStorage.
  -- Not a real fingerprint: a fingerprint built from the user agent and the
  -- screen is the same on every unit of the same model, which is exactly
  -- the fleet this is for.
  device_id       text not null,
  -- For the rate limit on code creation. Never shown.
  ip              text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  -- Filled in by the office.
  restaurant_id   uuid references restaurants(id) on delete cascade,
  linked_at       timestamptz,
  linked_by       text,
  token_hash      text,
  -- When the device collected the token. A second collection is refused.
  consumed_at     timestamptz
);

create index if not exists kiosk_link_codes_device_idx
  on kiosk_link_codes (device_id, created_at desc);

create index if not exists kiosk_link_codes_ip_idx
  on kiosk_link_codes (ip, created_at desc);

alter table kiosk_link_codes enable row level security;

comment on table kiosk_link_codes is
  'Six-digit codes a session-less kiosk shows so the office can link it to a restaurant from the CRM. Bound to the device that asked; thirty-minute life; token_hash collected once by that device. Service role only.';

-- The login audit gains the new way a login comes to be used.
alter table restaurant_login_audit drop constraint if exists restaurant_login_audit_action_check;
alter table restaurant_login_audit
  add constraint restaurant_login_audit_action_check
  check (action in ('created', 'password_reset', 'password_shown', 'password_printed', 'linked'));
