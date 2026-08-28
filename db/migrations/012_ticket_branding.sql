-- ============================================================================
-- Migration 012: CRM-editable ticket branding
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Images stay in the row as base64 rather than moving to blob storage. They
-- are kilobytes (Ariella's wordmark is 2.7KB), they are read on the print
-- path - which must not depend on another service being reachable while a
-- cook waits - and keeping them here means a restaurant's branding travels
-- with its row in every backup and restore.

alter table restaurants add column if not exists ticket_footer_mode text
  not null default 'qr_with_text';
alter table restaurants drop constraint if exists restaurants_ticket_footer_mode_check;
alter table restaurants add constraint restaurants_ticket_footer_mode_check
  check (ticket_footer_mode in ('qr_with_text', 'text_only', 'image'));

alter table restaurants add column if not exists ticket_footer_image_b64 text;

comment on column restaurants.ticket_footer_mode is
  'qr_with_text = message + QR to footer_url; text_only = message alone; image = footer_image only.';
comment on column restaurants.ticket_footer_image_b64 is
  'Base64 PNG, already normalised to 576px mono by the bridge on upload.';
