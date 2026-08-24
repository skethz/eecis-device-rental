create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.email() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
drop role if exists anon; drop role if exists authenticated; drop role if exists service_role;
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create extension if not exists btree_gist;

-- Emulate Supabase's baseline schema privilege (a platform-level default, distinct from
-- per-table Data API exposure which real migrations must grant explicitly). Base-table
-- grants (select/insert/... on devices, rentals, etc.) are NOT shimmed here on purpose:
-- they must come from the migrations themselves (see 0003_rls_and_rpc.sql), so the tests
-- exercise the same grants that will apply on real Supabase.
grant usage on schema public to anon, authenticated, service_role;

-- 0005_webhooks_cron.sql needs pg_net/pg_cron and is skipped by run.sh, but it is also
-- where public.call_notify() is defined, and later migrations attach triggers to it.
-- Stub it as a no-op so those CREATE TRIGGERs load; the real one POSTs to `notify`.
create or replace function public.call_notify() returns trigger
language plpgsql as $$ begin return new; end $$;
