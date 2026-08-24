create extension if not exists pg_net;
create extension if not exists pg_cron;
-- Owner must run once in SQL editor before applying:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'functions_url');
--   select vault.create_secret('<random>', 'webhook_secret');
--   select vault.create_secret('<random>', 'cron_secret');
-- Notification is best effort: a missing secret or an unreachable pg_net must never
-- abort the borrower's insert/update, so every failure here is only a warning.
create or replace function public.call_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'webhook_secret';
  if url is null or secret is null then
    raise warning 'call_notify skipped: functions_url or webhook_secret missing from vault';
    return new;
  end if;
  begin
    perform net.http_post(
      url := url || '/notify',
      headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret',secret),
      body := jsonb_build_object('type', tg_op, 'table', tg_table_name,
                'record', to_jsonb(new), 'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end));
  exception when others then
    raise warning 'call_notify failed: %', sqlerrm;
  end;
  return new;
end $$;
create trigger rentals_notify after insert or update of status on rentals for each row execute function public.call_notify();
create trigger ext_notify after insert on extension_requests for each row execute function public.call_notify();

select cron.schedule('overdue-check', '0 6 * * *',   -- 06:00 UTC = 08:00 Zurich (07:00 in winter)
$$ select net.http_post(
     url := (select decrypted_secret from vault.decrypted_secrets where name='functions_url') || '/overdue-check',
     headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret'))) $$);
