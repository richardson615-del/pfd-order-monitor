-- ============================================================================
-- Migration 038: why a ticket printed, and why it must not
-- ============================================================================
--
-- 2026-09-15: an eleven-day-old order printed at a restaurant. Nothing
-- between the queue and the paper asked how old the order was, a reprint
-- reset the retry budget, and an empty paper roll burned three attempts
-- in fifteen seconds and then paged the tech team with `ePOS
-- code="EPTR_REC_EMPTY"`. lib/print-policy.ts holds the rules; this is the
-- state they need.
--
--   queued_by          who put it here: ingest | test | login_print |
--                      reprint:<actor>. "Why did this print?" from the row.
--   manual_reprint_at  when somebody last pressed Print for it. An order
--                      older than PRINT_MAX_AGE_HOURS prints only inside
--                      ten minutes of this.
--   held_since /       first and latest time the printer parked it (out of
--   held_at            paper, cover open). Released on the device's later
--                      polls; failed with the reason after an hour.
--
-- Two new statuses:
--   expired  the order was too old at claim time. Never printed, never a
--            ticket for the tech team - "Expired, not needed".
--   held     the printer is waiting for a person, not a retry.
--
-- Nullable, no defaults on the new columns: rows written before this
-- migration genuinely do not know who queued them.

alter table print_jobs drop constraint if exists print_jobs_status_check;
alter table print_jobs add constraint print_jobs_status_check
  check (status in ('queued', 'claimed', 'printed', 'failed', 'held', 'expired', 'failed_acknowledged'));

alter table print_jobs add column if not exists queued_by text;
alter table print_jobs add column if not exists manual_reprint_at timestamptz;
alter table print_jobs add column if not exists held_since timestamptz;
alter table print_jobs add column if not exists held_at timestamptz;

comment on column print_jobs.queued_by is
  'Who put this job in the queue: ingest | test | login_print | reprint:<actor>. Null = written before migration 038.';
comment on column print_jobs.manual_reprint_at is
  'When Print was last pressed for this job. An order older than PRINT_MAX_AGE_HOURS is expired at claim time unless this is within the last ten minutes.';
comment on column print_jobs.held_since is
  'When the printer first parked this job (out of paper / cover open). Failed with the reason once this is an hour old.';
comment on column print_jobs.held_at is
  'When the printer last parked this job. Offered again two minutes later.';
