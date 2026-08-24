\set ON_ERROR_STOP on
begin;
insert into auth.users(id, email) values
  ('00000000-0000-0000-0000-000000000001', 'u1@ethz.ch'),
  ('00000000-0000-0000-0000-000000000002', 'u2@ethz.ch');
insert into devices(name, maker, model, unit_no) values ('Schema Test Device', null, null, 1);
-- blank manager name must be rejected
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
  select id, '00000000-0000-0000-0000-000000000001','A','a@ethz.ch','  ','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05' from devices where name='Schema Test Device';
  raise exception 'blank manager_name accepted';
exception when check_violation then null; end $$;
-- overlapping approved rentals on same device must be rejected
insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date,status)
  select id, '00000000-0000-0000-0000-000000000001','A','a@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05','approved' from devices where name='Schema Test Device';
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date,status)
    select id, '00000000-0000-0000-0000-000000000002','B','b@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-03','2026-09-10','approved' from devices where name='Schema Test Device';
  raise exception 'overlap accepted';
exception when exclusion_violation then null; end $$;
-- pending overlap is fine
insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
  select id, '00000000-0000-0000-0000-000000000002','B','b@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-03','2026-09-10' from devices where name='Schema Test Device';
select 'schema ok';
rollback;
