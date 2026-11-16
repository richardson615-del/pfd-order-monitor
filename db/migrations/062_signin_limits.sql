-- 062: sign-in hardening SH3a (Z-08, Z-10, Z-37). prs-crm QUEUE row 293,
-- brief prs-crm docs/briefs/2026-11-07-z-bridge-signin-hardening.md.
--
-- Z-08: a texted code's tries were read-then-write, so parallel guesses all
--       saw the same count. claim_login_code_try counts the try in one
--       statement and only while the code is still good.
-- Z-10 / Z-37: /api/app/code counted only phones on file and /api/app/login
--       had no limiter. app_signin_attempts logs each code request (per phone
--       hash and per address, before the owner lookup) and each failed
--       password sign-in (per username and per address).
--
-- Service-role only: RLS on, no policies.

create table if not exists app_signin_attempts (
  id bigserial primary key,
  -- code_phone / code_ip: a code was asked for; login_user / login_ip: a password sign-in failed.
  kind text not null check (kind in ('code_phone', 'code_ip', 'login_user', 'login_ip')),
  -- A phone is stored only as an HMAC (never the number); an address or a username as given, capped.
  key text not null check (char_length(key) <= 128),
  at timestamptz not null default now()
);
create index if not exists app_signin_attempts_key_idx on app_signin_attempts (kind, key, at desc);
alter table app_signin_attempts enable row level security;

-- One try on a code: +1 while it is unused, unexpired and under max_tries.
-- No row back = the code is used up, expired or out of tries (the caller says which from a fresh read).
create or replace function claim_login_code_try(code_id uuid, max_tries integer)
returns table (attempts integer)
language sql as $$
  update app_login_codes
     set attempts = app_login_codes.attempts + 1
   where id = code_id
     and app_login_codes.attempts < max_tries
     and used_at is null
     and expires_at > now()
  returning app_login_codes.attempts;
$$;

revoke all on function claim_login_code_try(uuid, integer) from public, anon, authenticated;
grant execute on function claim_login_code_try(uuid, integer) to service_role;
