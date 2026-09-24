-- ============================================================================
-- Migration 044: structured order line items (prs-crm QUEUE row 66, Matt
-- 2026-09-24)
-- ============================================================================
--
-- orders.items is shaped for the kitchen ticket: quantity folded into the
-- name ("2x Cheeseburger"), money as a display string ("$23.00"), options as
-- print lines. Fine on paper, useless for "what sells" - the CRM's statement
-- "top item" and the marketing engine's favourite-item targeting both need
-- quantity as a number, the line's own total, and a stable id to group by.
-- Every one of those fields was already in LoadOrder's selection and sitting
-- in raw_payload; mapZupplerGraphqlOrder() now also writes them here.
--
-- Shape (jsonb array, snake_case, one element per cart line):
--   { name, quantity, item_total (dollars, extended, paid options included),
--     category, menu_id, item_id }
-- Null for email and phone orders and for any Zuppler order the one-time
-- backfill (scripts/backfill-line-items.ts) has not reached. Additive only:
-- items, money columns and printing are untouched.

alter table orders
  add column if not exists line_items jsonb;

comment on column orders.line_items is
  'Structured cart lines for reporting (migration 044): [{name, quantity, item_total, category, menu_id, item_id}]. Zuppler only; items stays the print shape.';
