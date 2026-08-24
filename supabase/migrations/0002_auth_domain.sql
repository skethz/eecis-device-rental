create or replace function public.enforce_ethz_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is null or lower(new.email) !~ '(^|@|\.)ethz\.ch$' or position('@' in new.email) = 0 then
    raise exception 'Only ethz.ch email addresses may sign in (got %)', new.email;
  end if;
  return new;
end $$;
drop trigger if exists ethz_only on auth.users;
create trigger ethz_only before insert on auth.users
  for each row execute function public.enforce_ethz_email();
