-- Devices from the 2026-08 Taekwang inventory list (2608_Inventary_List_Taekwang.xlsx)
-- that do not overlap with the existing EECIS device list. They carry ETH inventory
-- numbers but no physical "Nr.x" sticker, so they are seeded as unlabelled.
-- The four DALCO r2264a8t servers are identical models and get unit_no 1-4 to stay distinct.
-- Left out on purpose: "Software Upgrade for Signal Source Analyzer Keysight E5058A" (a licence, not a device).
insert into devices(name, maker, model, unit_no, labelled) values
  ('Microscope', 'Süss Microtec', 'Mitutoyo FS-60FC', 1, false),
  ('Semiconductor Parameter Analyzer', 'Agilent Technologies', null, 1, false),
  ('DC Power Analyzer', 'Keysight', 'N6705C', 1, false),
  ('2U Quad Compute Server', 'DALCO', 'r2264a8t', 1, false),
  ('2U Quad Compute Server', 'DALCO', 'r2264a8t', 2, false),
  ('2U Quad Compute Server', 'DALCO', 'r2264a8t', 3, false),
  ('2U Quad Compute Server', 'DALCO', 'r2264a8t', 4, false),
  ('2U Quad Compute Server', 'DALCO', 'r2264a9t', 1, false),
  ('4U Rackmount Server', 'DALCO', 'r1464a10', 1, false),
  ('Compute Server', 'NVIDIA', 'GH200', 1, false),
  ('Pressure Controller', 'Druck', 'PACE 5000E', 1, false),
  ('Digital Microscope', 'Keyence', 'VHX-X1', 1, false)
on conflict do nothing;
