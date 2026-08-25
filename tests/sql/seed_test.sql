\set ON_ERROR_STOP on
do $$ declare n int; begin
  select count(*) into n from devices; if n <> 54 then raise exception 'expected 54 devices, got %', n; end if;
  select count(*) into n from devices where labelled; if n <> 35 then raise exception 'expected 35 labelled devices, got %', n; end if;
  select count(*) into n from devices where not labelled; if n <> 19 then raise exception 'expected 19 unlabelled devices, got %', n; end if;
  select count(*) into n from devices where not labelled and unit_no <> 1; if n <> 0 then raise exception 'unlabelled device with unit_no <> 1'; end if;
  select count(*) into n from devices where name='Isolation Transformer' and maker='Eaton' and model='IS1000HGDV' and not labelled;
  if n <> 1 then raise exception 'isolation transformer'; end if;
  select count(*) into n from devices where name='Saleae'; if n <> 6 then raise exception 'saleae'; end if;
  select count(*) into n from devices where name='Precision Source' and model='B2912A/B'; if n <> 4 then raise exception 'b2912'; end if;
end $$;
select 'seed ok';
