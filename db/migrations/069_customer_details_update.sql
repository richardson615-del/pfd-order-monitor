-- ============================================================================
-- Migration 069: dispatch changed the customer's details on an order
-- ============================================================================
--
-- ED3 (Nick 2026-11-28, prs-crm brief 2026-11-28-edit-customer-details-on-
-- orders.md; Forrest's dispatcher feedback): dispatch fixes a wrong address,
-- phone, contact name or delivery directions in the CRM, and the restaurant
-- has to see it. POST /api/crm/orders/:id/actions { action: "update_customer" }
-- writes the new values into the columns the order already has
-- (customer_name, customer_phone, customer_address = "street | directions")
-- and stamps these:
--
--   customer_changed_at      when the CRM last changed them; null = never
--   customer_changed_fields  which ones: customer_name, customer_phone,
--                            delivery_address, delivery_notes
--   customer_change_seen_at  when somebody at the restaurant tapped the yellow
--                            "Customer details changed" banner; the banner
--                            shows while this is null or older than
--                            customer_changed_at
--
-- customer_changed_at also stops a later Zuppler revision from putting the old
-- name / phone / address back (lib/customer-update.ts keepCrmCustomerEdits).
--
-- Additive and nullable, no default: every existing order reads as "never
-- changed", and nothing that selects specific order columns today reads
-- these. The tablet reads orders with select("*"); a screen built before this
-- ignores the extra keys.

alter table orders
  add column if not exists customer_changed_at timestamptz,
  add column if not exists customer_changed_fields text[],
  add column if not exists customer_change_seen_at timestamptz;

comment on column orders.customer_changed_at is
  'When dispatch last changed the customer details from the CRM (update_customer, ED3). Null = never.';
comment on column orders.customer_changed_fields is
  'Which customer details that change touched: customer_name, customer_phone, delivery_address, delivery_notes.';
comment on column orders.customer_change_seen_at is
  'When somebody at the restaurant tapped the "Customer details changed" banner. The banner shows while this is null or older than customer_changed_at.';

-- The tablet clears the banner itself (PATCH /api/orders/:id
-- { customer_seen: true }, the session client under RLS), so this one column
-- joins 063's column-limited UPDATE grant. Only the "seen" stamp: when and
-- what changed are written by the CRM through the service role.
-- scripts/test-orders-grants.ts pins this grant to exactly this column.
grant update (customer_change_seen_at) on table orders to authenticated;
