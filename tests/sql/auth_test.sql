\set ON_ERROR_STOP on
begin;
insert into auth.users(email) values ('ok@ethz.ch');
insert into auth.users(email) values ('Ok2@student.ethz.ch');
do $$ begin
  insert into auth.users(email) values ('x@gmail.com');
  raise exception 'gmail accepted';
exception when others then if sqlerrm not like '%ethz.ch%' then raise; end if; end $$;
do $$ begin
  insert into auth.users(email) values ('x@notethz.ch');
  raise exception 'notethz.ch accepted';
exception when others then if sqlerrm not like '%ethz.ch%' then raise; end if; end $$;
select 'auth ok';
rollback;
