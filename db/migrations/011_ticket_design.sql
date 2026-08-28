-- ============================================================================
-- Migration 011: per-restaurant ticket design
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- The header and footer print as bitmaps, so their look is data rather than
-- code: a restaurant's logo and which design direction it uses.
--
-- The logo is stored as base64 PNG rather than a URL. A URL means an outbound
-- fetch on the print path - the one path that must not depend on someone
-- else's uptime, DNS, or TLS while a cook is waiting for a ticket. These are
-- small mono images (Ariella's is 2.7KB).

alter table restaurants add column if not exists ticket_design_style text
  not null default 'bold';
alter table restaurants drop constraint if exists restaurants_ticket_design_style_check;
alter table restaurants add constraint restaurants_ticket_design_style_check
  check (ticket_design_style in ('classic', 'bold', 'editorial'));

alter table restaurants add column if not exists ticket_logo_b64 text;

comment on column restaurants.ticket_design_style is
  'Header/footer design direction: classic | bold | editorial.';
comment on column restaurants.ticket_logo_b64 is
  'Base64 PNG logo, rendered into the raster header. Null prints the name instead.';
