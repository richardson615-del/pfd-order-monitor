-- 060: Take the health check's weight off the database (outage 2026-11-11 20:52 CT: the Nano instance ran out of
-- memory and disk IO budget; printing and the CRM order feed timed out for about 25 minutes).
--
-- pg_stat_statements named the two heaviest statements, both from lib/health.ts collectSnapshot(), which runs
-- every minute from the cron and again from the CRM issues feed and every tablet's alert poll:
--   1. 35% of all database time: the volume baseline paging 35 days of orders out 1000 rows at a time
--      (1.53M page fetches) to count them in JavaScript. Now one aggregate, below.
--   2. 23%: open print jobs by status with no index to find them (278k calls, 25ms each). Partial index, below.
-- Safe to run twice.

create or replace function restaurant_order_volumes(
  p_baseline_start timestamptz,
  p_recent_start timestamptz,
  p_established_before timestamptz
)
returns table (restaurant_id uuid, recent bigint, baseline bigint, established boolean)
language sql
stable
as $$
  select o.restaurant_id,
         count(*) filter (where o.received_at >= p_recent_start) as recent,
         count(*) filter (where o.received_at < p_recent_start) as baseline,
         bool_or(o.received_at < p_established_before) as established
    from orders o
   where o.received_at >= p_baseline_start
     and o.source <> 'test'
     and o.restaurant_id is not null
   group by o.restaurant_id;
$$;

revoke all on function restaurant_order_volumes(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function restaurant_order_volumes(timestamptz, timestamptz, timestamptz) to service_role;

create index if not exists print_jobs_open_status_idx
  on print_jobs (status) where status in ('queued', 'claimed', 'held', 'failed');
