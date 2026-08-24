alter table devices enable row level security;
alter table rentals enable row level security;
alter table extension_requests enable row level security;
alter table action_tokens enable row level security;   -- no policies: service role only

-- Base-table Data API grants: new entities are not auto-exposed to anon/authenticated
-- on Supabase, so PostgREST/RPC access needs an explicit grant here (RLS policies below
-- then restrict which rows are visible/writable).
grant usage on schema public to anon, authenticated, service_role;
grant select on public.devices to authenticated;
grant select, insert on public.rentals to authenticated;
grant select on public.extension_requests to authenticated;
grant all on public.devices, public.rentals, public.extension_requests, public.action_tokens to service_role;

create policy devices_read on devices for select to authenticated using (true);
create policy rentals_own_read on rentals for select to authenticated using (user_id = auth.uid());
-- borrower_email must be the signed-in user's own address: it is what every notification
-- (decision, overdue warning) is sent to, so a spoofed value would let a user aim mail
-- from this system at someone else.
create policy rentals_own_insert on rentals for insert to authenticated
  with check (user_id = auth.uid() and borrower_email = auth.email() and status = 'pending');
create policy ext_own_read on extension_requests for select to authenticated
  using (exists (select 1 from rentals r where r.id = rental_id and r.user_id = auth.uid()));

create or replace function public.request_extension(p_rental_id bigint, p_new_end_date date)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rentals; new_id bigint;
begin
  select * into r from rentals where id = p_rental_id and user_id = auth.uid();
  if r.id is null then raise exception 'rental not found'; end if;
  if r.status <> 'approved' then raise exception 'only approved rentals can be extended'; end if;
  if p_new_end_date <= r.end_date then raise exception 'new end date must be later than %', r.end_date; end if;
  if exists (select 1 from extension_requests where rental_id = r.id and status = 'pending') then
    raise exception 'an extension request is already pending'; end if;
  insert into extension_requests(rental_id, new_end_date) values (r.id, p_new_end_date) returning id into new_id;
  return new_id;
end $$;

create or replace function public.mark_returned(p_rental_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update rentals set status = 'returned', returned_at = now()
   where id = p_rental_id and user_id = auth.uid() and status = 'approved';
  if not found then raise exception 'rental not found or not approved'; end if;
end $$;

create or replace view public.device_availability with (security_invoker = false) as
  select d.id as device_id, d.name, d.maker, d.model, d.unit_no,
         coalesce(array_agg(daterange(r.start_date, r.end_date, '[]') order by r.start_date)
                  filter (where r.id is not null), '{}') as busy
    from devices d
    left join rentals r on r.device_id = d.id and r.status = 'approved' and r.end_date >= current_date
   where d.active
   group by d.id;
grant select on public.device_availability to authenticated;
grant execute on function public.request_extension(bigint, date), public.mark_returned(bigint) to authenticated;
