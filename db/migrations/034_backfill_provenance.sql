-- Migration 033: backfill provenance
--
-- Distinguishes an order recovered after the fact from one ingested through
-- the normal webhook/poll path. Added for the Sep 2026 backfill: ~792
-- webhook_receipts rows bounced status=unmapped because the receiving
-- restaurant wasn't yet registered in restaurant_zuppler_ids. Once a
-- restaurant IS registered, scripts/backfill-zuppler-orders.ts replays each
-- bounced order_uuid through the same fetchZupplerOrder()/mapZupplerGraphqlOrder()
-- path the webhook uses, and stamps this column so a backfilled row is never
-- mistaken for one the webhook actually delivered live.
--
-- NULL means "ingested normally" -- this column is written only by the
-- backfill script, never by the webhook or Gmail poller.
alter table orders add column if not exists ingested_via text;

comment on column orders.ingested_via is
  'Non-null only for orders recovered outside the normal webhook/poll path, e.g. replay_backfill. NULL = ingested live.';
