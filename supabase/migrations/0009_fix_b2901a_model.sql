-- The Precision Source seeded in 0004 was listed as B2902A; the device is a B2901A.
update devices set model = 'B2901A'
where name = 'Precision Source' and maker = 'Keysight' and model = 'B2902A';
