-- ============================================================================
-- Migration 041: capture customer.email (2026-09-19, prs-crm Marketing &
-- Pricing pillar Phase 1)
-- ============================================================================
--
-- Zuppler's own LoadOrder query has always requested `customer { uuid name
-- email phone }` (see lib/zuppler-mapper.ts's LOAD_ORDER_QUERY) -- email was
-- arriving on every order and sitting unread in raw_payload the whole time.
-- mapZupplerGraphqlOrder() now reads it out alongside name/phone; this column
-- is where it lands. Additive only -- nothing else about order mapping
-- changes.
--
-- Nullable: the email-leg (AEM) parser has no email extraction at all today
-- (a real, separate, smaller gap -- see docs/marketing-pricing-spec.md in
-- prs-crm), and a customer can simply decline to give Zuppler one.

alter table orders
  add column if not exists customer_email text;

comment on column orders.customer_email is
  'Customer email, Zuppler orders only as of 2026-09-19 -- the email-leg (AEM) parser does not extract one. Was always present in raw_payload; this column is where it is now also stored directly.';
