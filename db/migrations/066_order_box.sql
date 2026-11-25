-- 066: PFD's touchscreen order box (Matt, 2026-11-25: "build all of those
-- features"). The box already prints through Server Direct Print like an
-- Eatabit; these columns carry what its screen adds. All service role only:
-- the box talks to /api/print/box with its device key, the CRM through the
-- CRM key. Safe to run twice.

-- Who is coming for the order, pushed by the CRM's delivery sync
-- (POST /api/crm/orders/:id/actions { action: "driver" }). First name only,
-- never a phone. driver_eta_at is when the driver should reach the
-- restaurant; null when the CRM cannot tell.
alter table orders
  add column if not exists driver_name text check (driver_name is null or length(driver_name) <= 40),
  add column if not exists driver_status text check (driver_status is null or driver_status in ('assigned', 'at_pickup', 'picked_up')),
  add column if not exists driver_eta_at timestamptz,
  add column if not exists driver_updated_at timestamptz;

-- The kitchen refused a marketplace order on the box (Uber Eats only). The CRM
-- reads it from the order feed, denies the order with Uber using the code, and
-- cancels the kitchen copy through the bridge's cancel action.
alter table orders
  add column if not exists kitchen_denied_at timestamptz,
  add column if not exists kitchen_deny_code text check (kitchen_deny_code is null or kitchen_deny_code in ('CAPACITY', 'ITEM_AVAILABILITY', 'STORE_CLOSED', 'OTHER'));

-- What the box reports about its printer, and one remote command at a time
-- from the CRM (reboot, screenshot, reprint). box_command_sent_at is stamped
-- when the box is handed the command; box_command_done_at when it reports back.
alter table print_devices
  add column if not exists printer_status text check (printer_status is null or printer_status in ('ok', 'paper_low', 'paper_out', 'cover_open', 'offline')),
  add column if not exists printer_status_at timestamptz,
  add column if not exists box_link text check (box_link is null or box_link in ('wifi', 'backup')),
  add column if not exists box_command text check (box_command is null or length(box_command) <= 80),
  add column if not exists box_command_at timestamptz,
  add column if not exists box_command_sent_at timestamptz,
  add column if not exists box_command_done_at timestamptz,
  add column if not exists box_command_result text check (box_command_result is null or length(box_command_result) <= 200);

-- The box's idle screen line, set from the CRM. Plain text, one or two short lines.
alter table restaurants
  add column if not exists box_promo text check (box_promo is null or length(box_promo) <= 120);

-- The latest screenshot per box (PNG). One row per device, overwritten.
create table if not exists device_screens (
  device_id  uuid primary key references print_devices(id) on delete cascade,
  png        bytea not null,
  width      integer not null,
  height     integer not null,
  taken_at   timestamptz not null default now()
);
alter table device_screens enable row level security;

comment on column orders.driver_name is '066: the driver''s first name from the CRM delivery sync, shown on the order box.';
comment on column orders.driver_status is '066: assigned | at_pickup | picked_up, from the CRM delivery sync.';
comment on column orders.driver_eta_at is '066: when the driver should reach the restaurant; null when unknown.';
comment on column orders.kitchen_denied_at is '066: the kitchen refused this Uber Eats order on the order box; the CRM denies it with Uber.';
comment on column print_devices.printer_status is '066: what the order box last said about its printer (paper, cover).';
comment on column print_devices.box_command is '066: one pending remote command for the order box: reboot | screenshot | reprint:<order_number>.';
comment on table device_screens is '066: the latest order box screenshot, PNG, one per device.';
