-- Device proposals: any signed-in ETH user who buys a device for the group can propose
-- it here, and the lab manager approves or denies it through the same emailed
-- single-use-token flow the rentals already use (notify -> decide.html -> POST /decide).
-- Approving inserts the device into `devices`; until then nothing about the device list
-- changes, so a proposal can never make a device rentable on its own.

-- action_tokens gains a third kind. 0001 created the constraint as the default
-- <table>_<column>_check name; `if exists` keeps this migration re-runnable.
alter table action_tokens drop constraint if exists action_tokens_kind_check;
alter table action_tokens add constraint action_tokens_kind_check
  check (kind in ('rental','extension','device'));

create table device_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  -- The proposer's own name and address: every mail about this proposal goes to
  -- proposer_email, so the insert policy below pins it to the signed-in user.
  proposer_name text not null check (btrim(proposer_name) <> ''),
  proposer_email text not null,
  -- The proposed device, mirroring the columns of `devices`.
  name text not null check (btrim(name) <> ''),
  maker text,
  model text,
  unit_no int not null default 1 check (unit_no > 0),
  labelled boolean not null default true,
  note text,
  status decision_status not null default 'pending',
  created_at timestamptz default now(),
  decided_at timestamptz,
  -- Filled in on approval with the device row that was created from this proposal.
  device_id bigint references devices(id)
);
create index on device_requests(user_id);

alter table device_requests enable row level security;

-- Base-table Data API grants (see the note in 0003): a new table is not auto-exposed.
-- No update/delete for authenticated — a proposal is only ever decided by the `decide`
-- edge function, which runs as service_role.
grant select, insert on public.device_requests to authenticated;
grant all on public.device_requests to service_role;

-- proposer_email must be the signed-in user's own address for the same reason
-- borrower_email is on rentals: it is where the decision email is sent, so a spoofed
-- value would let a user aim mail from this system at someone else.
create policy device_requests_own_insert on device_requests for insert to authenticated
  with check (user_id = auth.uid() and proposer_email = auth.email() and status = 'pending');
-- Proposers see their own proposals; admins see everyone's, so the same list on
-- devices.html doubles as the lab manager's overview.
create policy device_requests_read on device_requests for select to authenticated
  using (user_id = auth.uid() or is_admin());

-- Same best-effort webhook the rentals use (0005): it posts the new row to the `notify`
-- edge function, which mails the lab manager the approve/deny links.
create trigger device_requests_notify after insert on device_requests
  for each row execute function public.call_notify();
