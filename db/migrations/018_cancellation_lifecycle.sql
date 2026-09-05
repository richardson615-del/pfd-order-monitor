-- ============================================================================
-- Migration 018: make cancellation a timestamp, not an overwritten status
-- Run in Supabase SQL Editor. Safe to run more than once.
-- ============================================================================
--
-- Seven orders totalling $156.34 read as 'cancelled' while carrying a
-- printed_at - real tickets that came out of a real printer and were then
-- cancelled upstream, in one case eleven hours later.
--
-- The status column was doing two jobs at once: telling the kitchen what to
-- do, and telling accounting what earned money. Those diverge the moment an
-- order is cancelled AFTER printing, and a single string cannot express both.
--
-- status keeps its operational meaning - 'cancelled' is what the dashboard
-- should say, because nobody should make that food. cancelled_at records WHEN,
-- and printed_at survives untouched, so "printed, then cancelled" is a state
-- the data can actually describe instead of one that erases the other.

alter table orders add column if not exists cancelled_at timestamptz;

-- Cancelled after the ticket was already out. Worth finding quickly: the
-- kitchen may have made the food, and the money question is genuinely open.
create index if not exists orders_cancelled_after_print_idx
  on orders (cancelled_at)
  where cancelled_at is not null and printed_at is not null;

comment on column orders.cancelled_at is
  'When the cancellation arrived. Null means never cancelled. With printed_at also set, the ticket had already been printed - the food may exist.';
