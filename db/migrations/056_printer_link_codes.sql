-- ============================================================================
-- Migration 056: pair codes - a printer with no device key pairs from the office
-- ============================================================================
--
-- Same idea as kiosk_link_codes (035), for the Eatabit boxes: a printer on
-- WiFi with no device key shows a six-digit code on its screen. Somebody in
-- the office types the code against a restaurant; that registers a
-- print_devices row and parks its key on the code row; the printer that asked
-- for the code collects the key once on its next poll. Nobody copies a key or
-- opens the printer's settings page.
--
-- device_key here is the only copy outside print_devices, and only until the
-- printer collects it: the collect step blanks it.
--
-- Service role only: no policies, RLS on.

create table if not exists printer_link_codes (
  code             text primary key,
  device_id        text not null,
  ip               text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  restaurant_id    uuid references restaurants(id) on delete cascade,
  print_device_id  uuid references print_devices(id) on delete cascade,
  linked_at        timestamptz,
  linked_by        text,
  device_key       text,
  consumed_at      timestamptz
);

create index if not exists printer_link_codes_device_idx
  on printer_link_codes (device_id, created_at desc);

create index if not exists printer_link_codes_ip_idx
  on printer_link_codes (ip, created_at desc);

alter table printer_link_codes enable row level security;

comment on table printer_link_codes is
  'Six-digit codes an unpaired printer shows so the office can pair it to a restaurant. Bound to the printer that asked; thirty-minute life; the device key is collected once by that printer and then blanked. Service role only.';
