\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('11111111-1111-1111-1111-111111111111','a@ethz.ch'),('22222222-2222-2222-2222-222222222222','b@ethz.ch');
insert into devices(name,unit_no) values ('Saleae RLS Test',1);
set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local request.jwt.claim.email = 'a@ethz.ch';
insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
  select id,'11111111-1111-1111-1111-111111111111','A','a@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05' from devices where name='Saleae RLS Test';
-- authenticated cannot directly update rentals (no UPDATE grant; must go through the RPCs)
do $$ begin
  update rentals set status='approved' where user_id = '11111111-1111-1111-1111-111111111111';
  raise exception 'direct update accepted';
exception when insufficient_privilege then null; end $$;
-- cannot insert as someone else
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
    select id,'22222222-2222-2222-2222-222222222222','B','b@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05' from devices where name='Saleae RLS Test';
  raise exception 'spoofed user_id accepted';
exception when insufficient_privilege then null; end $$;
-- cannot claim someone else's borrower_email (all our mail goes to that address)
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
    select id,'11111111-1111-1111-1111-111111111111','A','victim@gmail.com','M','m@ethz.ch','P','p@ethz.ch','2026-10-01','2026-10-05' from devices where name='Saleae RLS Test';
  raise exception 'spoofed borrower_email accepted';
exception when insufficient_privilege then null; end $$;
-- action_tokens is service-role only: RLS is on with no policies and no grant
do $$ begin
  perform 1 from action_tokens;
  raise exception 'authenticated read of action_tokens accepted';
exception when insufficient_privilege then null; end $$;
-- B sees nothing of A
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set local request.jwt.claim.email = 'b@ethz.ch';
do $$ declare n int; begin select count(*) into n from rentals; if n <> 0 then raise exception 'leak'; end if; end $$;
-- mark_returned on pending fails; on approved succeeds (approve as service role)
reset role; update rentals set status='approved';
set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; set local request.jwt.claim.email = 'a@ethz.ch';
select request_extension(id, '2026-09-08') from rentals;
do $$ begin perform request_extension((select id from rentals), '2026-09-02'); raise exception 'short extension accepted';
exception when others then if sqlerrm not like '%later than%' then raise; end if; end $$;
-- A sees her own extension_request; B cannot see A's extension_requests
do $$ declare n int; begin select count(*) into n from extension_requests; if n <> 1 then raise exception 'expected 1 own extension_request, got %', n; end if; end $$;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set local request.jwt.claim.email = 'b@ethz.ch';
do $$ declare n int; begin select count(*) into n from extension_requests; if n <> 0 then raise exception 'extension leak'; end if; end $$;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; set local request.jwt.claim.email = 'a@ethz.ch';
select mark_returned(id) from rentals;
do $$ declare s rental_status; begin select status into s from rentals; if s <> 'returned' then raise exception 'not returned'; end if; end $$;
-- devices are editable by admins only (is_admin(), 0006)
do $$ begin if is_admin() then raise exception 'non-admin is_admin() returned true'; end if; end $$;
do $$ declare n int; begin
  select count(*) into n from admins;
  if n <> 0 then raise exception 'non-admin sees % admins rows', n; end if;
end $$;
do $$ begin
  insert into devices(name, unit_no) values ('Rogue Device', 1);
  raise exception 'non-admin device insert accepted';
exception when insufficient_privilege then null; end $$;
-- A non-admin's UPDATE matches no rows at all (devices_admin_update's USING clause hides
-- them), so it silently changes nothing rather than raising.
do $$ declare n int; begin
  update devices set name = 'Hacked' where name = 'Saleae RLS Test';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'non-admin device update changed % rows', n; end if;
end $$;
-- the admin can do both
set local request.jwt.claim.email = 'hongse@ethz.ch';
do $$ begin if not is_admin() then raise exception 'admin is_admin() returned false'; end if; end $$;
do $$ declare n int; begin
  select count(*) into n from admins;
  if n <> 1 then raise exception 'admin sees % admins rows', n; end if;
end $$;
insert into devices(name, maker, model, unit_no, labelled) values ('Admin Added Device', 'ACME', 'X1', 1, false);
update devices set model = 'X2', active = false where name = 'Admin Added Device';
do $$ declare n int; begin
  select count(*) into n from devices where name = 'Admin Added Device' and model = 'X2' and not active and not labelled;
  if n <> 1 then raise exception 'admin insert/update did not take effect'; end if;
end $$;
set local request.jwt.claim.email = 'a@ethz.ch';
-- device_status deliberately shows every signed-in user who has each device, including
-- rentals that are not their own; it is limited to pending/approved and not-yet-ended.
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set local request.jwt.claim.email = 'b@ethz.ch';
do $$ declare n int; begin
  select count(*) into n from device_status where borrower_email = 'a@ethz.ch';
  if n <> 0 then raise exception 'returned rental still listed in device_status'; end if;
end $$;
reset role;
update rentals set status = 'approved', start_date = current_date, end_date = current_date + 3;
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set local request.jwt.claim.email = 'b@ethz.ch';
do $$ declare d device_status; begin
  select * into d from device_status where borrower_email = 'a@ethz.ch';
  if d.rental_id is null then raise exception 'device_status hides another user''s approved rental'; end if;
  if d.status <> 'approved' or d.manager_email <> 'm@ethz.ch' or d.professor_name <> 'P' then
    raise exception 'device_status columns wrong: %', d; end if;
end $$;
reset role;
update rentals set start_date = current_date - 5, end_date = current_date - 1;
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set local request.jwt.claim.email = 'b@ethz.ch';
do $$ declare n int; begin
  select count(*) into n from device_status;
  if n <> 0 then raise exception 'device_status lists a rental that already ended'; end if;
end $$;
-- device proposals (0007): everyone may propose, but only for themselves
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; set local request.jwt.claim.email = 'a@ethz.ch';
insert into device_requests(user_id, proposer_name, proposer_email, name, maker, model, unit_no, labelled, note)
  values ('11111111-1111-1111-1111-111111111111','A','a@ethz.ch','Proposed Scope A','ACME','S1',1,true,'bought for the group');
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; set local request.jwt.claim.email = 'b@ethz.ch';
insert into device_requests(user_id, proposer_name, proposer_email, name)
  values ('22222222-2222-2222-2222-222222222222','B','b@ethz.ch','Proposed Scope B');
-- ...not on someone else's behalf, and not with someone else's address (that is where
-- the decision mail goes)
do $$ begin
  insert into device_requests(user_id, proposer_name, proposer_email, name)
    values ('11111111-1111-1111-1111-111111111111','A','a@ethz.ch','Spoofed Owner');
  raise exception 'spoofed device_requests user_id accepted';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into device_requests(user_id, proposer_name, proposer_email, name)
    values ('22222222-2222-2222-2222-222222222222','B','victim@gmail.com','Spoofed Email');
  raise exception 'spoofed proposer_email accepted';
exception when insufficient_privilege then null; end $$;
-- a proposal may not be born already approved
do $$ begin
  insert into device_requests(user_id, proposer_name, proposer_email, name, status)
    values ('22222222-2222-2222-2222-222222222222','B','b@ethz.ch','Pre-approved','approved');
  raise exception 'pre-approved proposal accepted';
exception when insufficient_privilege then null; end $$;
-- B sees only her own proposal, not A's
do $$ declare n int; begin
  select count(*) into n from device_requests;
  if n <> 1 then raise exception 'expected 1 own proposal, got %', n; end if;
  if not exists (select 1 from device_requests where name = 'Proposed Scope B') then
    raise exception 'own proposal not visible'; end if;
end $$;
-- authenticated may never decide a proposal itself (no update grant)
do $$ begin
  update device_requests set status = 'approved' where name = 'Proposed Scope B';
  raise exception 'direct device_requests update accepted';
exception when insufficient_privilege then null; end $$;
-- an admin (a third user, owning none of them) sees both
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333'; set local request.jwt.claim.email = 'hongse@ethz.ch';
do $$ declare n int; begin
  select count(*) into n from device_requests;
  if n <> 2 then raise exception 'admin sees % proposals, expected 2', n; end if;
end $$;
reset role;
-- action_tokens now also carries the 'device' kind (0007)
insert into action_tokens(kind, target_id) select 'device', id from device_requests where name = 'Proposed Scope A';
do $$ begin
  insert into action_tokens(kind, target_id) values ('nonsense', 1);
  raise exception 'unknown action_tokens kind accepted';
exception when check_violation then null; end $$;
select count(*) as busy from device_availability where name='Saleae RLS Test';
select 'rls ok';
rollback;
