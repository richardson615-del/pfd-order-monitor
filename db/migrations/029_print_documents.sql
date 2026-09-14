-- ============================================================================
-- Migration 029: a print job that is not an order
-- ============================================================================
--
-- Everything this system has ever printed has been an order, so print_jobs
-- required one: order_id is NOT NULL and the Epson endpoint renders a ticket
-- by joining orders. That was right while paper only ever carried food.
--
-- The CRM now needs to print a restaurant's tablet LOGIN at the restaurant -
-- username, password and the four setup steps, on the Epson already sitting
-- in their kitchen - so the person who has to type it is holding it, instead
-- of somebody reading a password down a phone line during service.
--
-- The obvious cheap route was to reuse the test-print path: insert a fake
-- order with the credentials in its items and let the existing renderer draw
-- it. That is rejected deliberately. A credential is not an order, and an
-- orders row is not an inert place to put one:
--
--   * it appears in the restaurant's own order list and on their tablet;
--   * it is counted by the health checks and the dashboard;
--   * it is excluded from accounting only because one query happens to say
--     `.neq("source", "test")`, which is one forgotten filter away from a
--     password in a statement;
--   * and the ticket would print inside an order frame, with an ORDER #, a
--     total of $0.00 and a "Scan to order again" QR under the password.
--
-- So a job may instead carry a DOCUMENT: a small, self-contained set of
-- ticket lines, rendered by the same line renderer the order path uses. No
-- order row, nothing for accounting to filter, and the ticket says what it
-- is on its face.
--
-- What a document must never become is a general "print this text" channel
-- reachable from outside - the column is written by bridge code only, and
-- the one route that writes it (POST /api/crm/restaurants/:id/logins/print)
-- composes the lines itself from a login it has already verified belongs to
-- that restaurant.

-- An order job still has an order. A document job has no order at all -
-- deliberately not a dangling reference to a placeholder row.
alter table print_jobs alter column order_id drop not null;

-- 'order' | 'document'. Defaulted so every existing row is what it always
-- was, and the constraint below can be validated without a backfill.
alter table print_jobs add column if not exists kind text not null default 'order';

-- The ticket lines themselves: [{ text, align?, bold?, size?, reverse?, qr? }],
-- the shape lib/ticket.ts already renders. Stored rather than re-derived at
-- print time, because what was printed must stay exactly what was composed -
-- a login ticket reprinted after a password reset would otherwise carry a
-- password the paper never had.
alter table print_jobs add column if not exists document jsonb;

-- Named constraints, added separately so re-running the file is safe.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'print_jobs_kind_check') then
    alter table print_jobs
      add constraint print_jobs_kind_check check (kind in ('order', 'document'));
  end if;

  -- Exactly one of the two payloads, matched to the kind. Without this, a
  -- document job with a null document is a row the printer polls forever and
  -- never prints, which is the silent-failure shape this whole system keeps
  -- being bitten by.
  if not exists (select 1 from pg_constraint where conname = 'print_jobs_payload_check') then
    alter table print_jobs
      add constraint print_jobs_payload_check check (
        (kind = 'order' and order_id is not null and document is null)
        or (kind = 'document' and document is not null and order_id is null)
      );
  end if;
end $$;

comment on column print_jobs.kind is
  'order = renders from the joined orders row (every job before migration 029). document = renders the ticket lines held in print_jobs.document, with no order row at all.';

comment on column print_jobs.document is
  'Ticket lines for a kind=''document'' job, in lib/ticket.ts''s TicketLine shape. Written by bridge code only - never by anything a restaurant or a device can reach.';
