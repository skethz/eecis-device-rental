create extension if not exists btree_gist;

create table devices (
  id bigint generated always as identity primary key,
  name text not null,
  maker text,
  model text,
  unit_no int not null,
  active boolean not null default true,
  unique nulls not distinct (name, maker, model, unit_no)
);

create type rental_status as enum ('pending','approved','denied','returned');
create type decision_status as enum ('pending','approved','denied');

create table rentals (
  id bigint generated always as identity primary key,
  device_id bigint not null references devices(id),
  user_id uuid not null references auth.users(id),
  borrower_name text not null check (btrim(borrower_name) <> ''),
  borrower_email text not null check (borrower_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  manager_name text not null check (btrim(manager_name) <> ''),
  manager_email text not null check (manager_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  professor_name text not null check (btrim(professor_name) <> ''),
  professor_email text not null check (professor_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  status rental_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  returned_at timestamptz,
  last_warned_on date,
  exclude using gist (device_id with =, daterange(start_date, end_date, '[]') with &&)
    where (status = 'approved')
);
create index on rentals(user_id);

create table extension_requests (
  id bigint generated always as identity primary key,
  rental_id bigint not null references rentals(id),
  new_end_date date not null,
  status decision_status not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table action_tokens (
  token uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rental','extension')),
  target_id bigint not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
