-- ============================================================================
-- Migration 045: ezCater Phase 2 - order-event subscriber (Matt, 2026-09-28;
-- prs-crm docs/ezcater-ingestion-spec.md §3, on top of #90's scaffold)
-- ============================================================================
--
-- PFD is caterer of record on ezCater: one API user sees every PFD location.
-- ezCater tells us about an order by POSTing a signed notification (no order
-- data in it) to our subscriber's webhook; we then fetch the order.
--
--   1. ezcater_locations - one row per ezCater caterer location, from their
--      Caterers query, linked by hand to the bridge restaurant that makes the
--      food. `active` is the switch: an inactive or unlinked location's
--      notifications are recorded and never ingested (Matt: Willie Mae's
--      first, the other five mapped and off "until I say").
--   2. ezcater_subscriber - ezCater allows ONE subscriber per API user and
--      returns its webhook secret ONCE, at creation. The create runs in
--      production (the only place EZCATER_API_TOKEN exists) and stores the
--      secret here, where only the service role can read it.
--   3. ezcater_orders - where an ingested ezCater order lands while ingestion
--      is being proven. NOT `orders` (Matt, 2026-09-28: "ezCater printing: OFF
--      for validation"): a row in `orders` reaches the printer queue, the
--      tablet's order screen and its realtime chime, the unaccepted-order
--      alerts that open CRM tickets, and the CRM's accounting feed. Keeping
--      the order here means none of those can see it. Promoting a proven
--      order into `orders` - with its own "ezCATER CATERING" ticket header,
--      lead-time routing and a per-location print toggle - is the next
--      package, and so is adding 'ezcater' to orders.source.

create table if not exists ezcater_locations (
  -- ezCater's caterer uuid: the Caterers query's `uuid`, a subscription's
  -- parentId and a notification's parent_id.
  caterer_uuid       text primary key,
  name               text not null,
  store_number       text,
  address            jsonb,
  -- ezCater's own `live` flag, as last synced.
  live               boolean,
  restaurant_id      uuid references restaurants(id) on delete set null,
  -- Ingest this location's orders. Never true without a restaurant.
  active             boolean not null default false,
  -- The order events this location is subscribed to at ezCater, as we last
  -- created or deleted them (e.g. {accepted,cancelled}).
  subscribed_events  text[] not null default '{}',
  last_synced_at     timestamptz,
  mapped_at          timestamptz,
  mapped_by          text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ezcater_locations_active_needs_restaurant check (not active or restaurant_id is not null)
);

alter table ezcater_locations enable row level security;

comment on table ezcater_locations is
  'ezCater caterer locations (Caterers query) linked by hand to a bridge restaurant. Only an active, linked location has its orders ingested (migration 045).';

create table if not exists ezcater_subscriber (
  -- ezCater's subscriber id.
  id              text primary key,
  name            text not null,
  webhook_url     text not null,
  -- Returned by ezCater only when the subscriber is created. Signs every
  -- notification (HMAC-SHA256). Service role only - see below.
  webhook_secret  text not null,
  created_at      timestamptz not null default now(),
  created_by      text
);

alter table ezcater_subscriber enable row level security;
-- RLS with no policy already denies anon/authenticated; revoke as well, the
-- way 027 does for restaurant passwords, so a future permissive policy on this
-- table cannot expose the secret by accident.
revoke all on ezcater_subscriber from anon, authenticated;

comment on table ezcater_subscriber is
  'The one ezCater subscriber this API user may have, with the webhook secret ezCater returned at creation (migration 045). Service role only.';

create table if not exists ezcater_orders (
  -- ezCater's order uuid (a notification's entity_id). The idempotency key:
  -- a modification arrives as a second `accepted` for the same id and
  -- updates this row.
  ezcater_order_id  text primary key,
  caterer_uuid      text not null references ezcater_locations(caterer_uuid),
  restaurant_id     uuid references restaurants(id) on delete set null,
  order_number      text not null,
  status            text not null check (status in ('accepted', 'cancelled')),
  fulfillment       text,
  -- The kitchen's deadline: ezCater's catererHandoffFoodTime (else the event time).
  event_time        timestamptz,
  customer_total    numeric(10, 2),
  -- #90's canonical mapping (lib/ezcater.ts ezCaterOrderToCanonical) - what
  -- promotion into `orders` will ingest.
  canonical         jsonb not null,
  -- ezCater's order exactly as fetched (provenance; holds catererTotalDue and
  -- the fees ezCater deducts, which the CRM's payout half will need).
  raw_payload       jsonb not null,
  last_event_key    text not null,
  last_event_at     timestamptz,
  event_count       integer not null default 1,
  -- Set on a modification that changed the order (the kitchen will need to know once tickets print).
  modified_at       timestamptz,
  cancelled_at      timestamptz,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Set when the next package moves the order into `orders`.
  promoted_order_id uuid references orders(id) on delete set null
);

create index if not exists ezcater_orders_restaurant_event_idx on ezcater_orders (restaurant_id, event_time);

-- Customer names, phones and addresses: service role only, like orders.
alter table ezcater_orders enable row level security;

comment on table ezcater_orders is
  'ezCater orders ingested from order-event notifications while ingestion is being proven (migration 045). Deliberately not in `orders`: nothing restaurant-facing or payout-facing reads this table.';
