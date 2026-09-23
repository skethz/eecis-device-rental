-- Group registry: borrowers pick their group from this list instead of typing their
-- lab manager's and professor's names and emails. Only admins (is_admin(), 0006) add or
-- edit groups; every signed-in user can read the list to fill the request form.
create table groups (
  id bigint generated always as identity primary key,
  name text not null check (btrim(name) <> ''),
  manager_name text not null check (btrim(manager_name) <> ''),
  manager_email text not null check (manager_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  professor_name text not null check (btrim(professor_name) <> ''),
  professor_email text not null check (professor_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  active boolean not null default true,
  unique nulls not distinct (name)
);

alter table groups enable row level security;

-- Same pattern as devices (0003/0006): readable by everyone signed in, writable by
-- admins only. No delete policy and no delete grant: retiring a group means setting
-- active = false, so the rentals that reference it keep their foreign key.
create policy groups_read on groups for select to authenticated using (true);
create policy groups_admin_insert on groups for insert to authenticated with check (is_admin());
create policy groups_admin_update on groups for update to authenticated using (is_admin()) with check (is_admin());
grant select, insert, update on public.groups to authenticated;
grant all on public.groups to service_role;

insert into groups(name, manager_name, manager_email, professor_name, professor_email) values
  ('Prof. Taekwang Jang (EECIS)', 'Seungki Hong', 'hongse@ethz.ch', 'Taekwang Jang', 'tkjang@ethz.ch')
on conflict do nothing;

-- The request form still snapshots the group's manager and professor into the existing
-- rentals columns, so a rental's history stays as it was if the group's manager changes
-- later; group_id only records which group was chosen. The rentals insert policy (0003)
-- and grant already cover the new column.
alter table rentals add column group_id bigint references groups(id);
