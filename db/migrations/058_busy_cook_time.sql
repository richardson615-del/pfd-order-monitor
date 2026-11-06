-- 058: Busy-time cook time, with limits and a change log (BT1, prs-crm QUEUE
-- row 241, Ticket #948; Nick 11/02: "it should be able to talk to us so we
-- know when to dispatch people").
--
-- restaurants.busy_*: a temporary boost on top of prep_minutes. It ends on its
-- own: readers go by busy_until (lib/cook-time.ts liveBusy), and the monitor
-- cron clears the columns and writes the log row (expire_busy_boosts below).
--
-- restaurants.cook_*: per-restaurant overrides of the kitchen's limits, written
-- only by the CRM. Null = the default in lib/cook-time.ts (+30 min, 2 h, 10-45).
-- A restaurant session cannot write any of these columns: restaurants has only
-- restaurants_admin_write for writes, so the tablet goes through the routes
-- that enforce the limits.
--
-- cook_time_log: one row per cook-time change from any source. Service role
-- only (RLS on, no policies). The CRM reads it by id, so a row written late
-- (an expiry) is still seen. Safe to run twice.

alter table restaurants
  add column if not exists busy_boost_minutes integer,
  add column if not exists busy_started_at timestamptz,
  add column if not exists busy_until timestamptz,
  add column if not exists busy_started_by text,
  add column if not exists cook_max_boost_minutes integer,
  add column if not exists cook_max_busy_minutes integer,
  add column if not exists cook_band_min integer,
  add column if not exists cook_band_max integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'restaurants_busy_boost_minutes_check') then
    alter table restaurants add constraint restaurants_busy_boost_minutes_check
      check (busy_boost_minutes is null or busy_boost_minutes between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'restaurants_cook_limits_check') then
    alter table restaurants add constraint restaurants_cook_limits_check check (
      (cook_max_boost_minutes is null or cook_max_boost_minutes between 1 and 120)
      and (cook_max_busy_minutes is null or cook_max_busy_minutes between 1 and 720)
      and (cook_band_min is null or cook_band_min between 1 and 180)
      and (cook_band_max is null or cook_band_max between 1 and 180)
    );
  end if;
end $$;

-- The cron's sweep: a boost past its end time only.
create index if not exists idx_restaurants_busy_until on restaurants (busy_until) where busy_until is not null;

create table if not exists cook_time_log (
  id              bigint generated always as identity primary key,
  restaurant_id   uuid not null references restaurants(id) on delete cascade,
  kind            text not null check (kind in ('default_change', 'boost_start', 'boost_end', 'boost_expire', 'running_late')),
  source          text not null check (source in ('tablet', 'partner_app', 'crm', 'system')),
  -- The tablet login, the PFD Partner owner's name, or the CRM user. Null for an expiry.
  actor           text,
  -- The minutes Accept pre-selects, before and after. Null on running_late.
  before_minutes  integer,
  after_minutes   integer,
  boost_minutes   integer,
  expires_at      timestamptz,
  -- running_late only. The number is kept so the row still names the order if it is ever removed.
  order_id        uuid references orders(id) on delete set null,
  order_number    text,
  before_ready_by timestamptz,
  after_ready_by  timestamptz,
  minutes_added   integer,
  created_at      timestamptz not null default now()
);

create index if not exists idx_cook_time_log_restaurant on cook_time_log (restaurant_id, id desc);
create index if not exists idx_cook_time_log_created_at on cook_time_log (created_at);

alter table cook_time_log enable row level security;

-- Clears every boost past its end and logs it, in one statement, so the two
-- cannot disagree and two runs at once cannot log one expiry twice. The row is
-- dated when the boost ended, not when the sweep noticed.
create or replace function expire_busy_boosts() returns integer
language sql as $$
  with due as (
    select id, prep_minutes, busy_boost_minutes, busy_until
    from restaurants
    where busy_until is not null and busy_until <= now()
    for update
  ),
  cleared as (
    update restaurants r
    set busy_boost_minutes = null, busy_started_at = null, busy_until = null, busy_started_by = null
    from due
    where r.id = due.id
    returning due.id, due.prep_minutes, due.busy_boost_minutes, due.busy_until
  ),
  logged as (
    insert into cook_time_log (restaurant_id, kind, source, before_minutes, after_minutes, boost_minutes, expires_at, created_at)
    select id, 'boost_expire', 'system', least(prep_minutes + busy_boost_minutes, 180), prep_minutes, busy_boost_minutes, busy_until, busy_until
    from cleared
    returning 1
  )
  select count(*)::integer from logged;
$$;

revoke all on function expire_busy_boosts() from public, anon, authenticated;
grant execute on function expire_busy_boosts() to service_role;

comment on column restaurants.busy_boost_minutes is
  '058: minutes the kitchen added for a busy spell; Accept pre-selects prep_minutes + this until busy_until.';
comment on column restaurants.busy_until is
  '058: when the boost ends: the chosen length or closing time, whichever is first.';
comment on column restaurants.cook_max_boost_minutes is
  '058: per-restaurant override of the largest boost a kitchen may start (null = 30). Written only by the CRM.';
comment on column restaurants.cook_max_busy_minutes is
  '058: per-restaurant override of the longest boost (null = 120). Written only by the CRM.';
comment on column restaurants.cook_band_min is
  '058: per-restaurant override of the lowest default cook time a kitchen may set itself (null = 10). Written only by the CRM.';
comment on column restaurants.cook_band_max is
  '058: per-restaurant override of the highest default cook time a kitchen may set itself (null = 45). Written only by the CRM.';
comment on table cook_time_log is
  '058: every cook-time change from any source: default change, boost start/end/expire, Running late. Read by the CRM through /api/crm/cook-time/changes and the order feed.';
