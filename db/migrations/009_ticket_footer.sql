-- ============================================================================
-- Migration 009: per-restaurant ticket footer
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- The bottom of a ticket is the one piece of print a customer reliably keeps,
-- so it is worth something: a restaurant's own message and a QR back to their
-- OWN ordering page, which is the direct channel this business exists to
-- defend. Nullable, because a restaurant with nothing set should fall back to
-- the PFD line rather than print an empty box.

alter table restaurants add column if not exists ticket_footer_text text;
alter table restaurants add column if not exists ticket_footer_url  text;

comment on column restaurants.ticket_footer_text is
  'Message printed under the totals. Null falls back to the global default.';
comment on column restaurants.ticket_footer_url is
  'Restaurant''s own online-ordering page, printed as a QR code. Null prints no QR.';
