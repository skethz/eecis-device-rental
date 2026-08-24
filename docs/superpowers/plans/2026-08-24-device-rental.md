# EECIS Device Rental Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free website (GitHub Pages + Supabase + Resend) where ETH members request EECIS devices, extend, return, and get daily overdue warnings; the lab manager approves via email links.

**Architecture:** Static HTML/JS site talks to Supabase (Postgres + Auth + RLS) directly. Three Deno edge functions handle email: `notify` (fired by DB webhooks on inserts/returns), `decide` (approve/deny via single-use token), `overdue-check` (called daily by pg_cron). Pure email/SQL logic lives in small testable modules.

**Tech Stack:** Supabase (Postgres 15, Auth magic link, Edge Functions on Deno), Resend REST API, vanilla ES modules + `@supabase/supabase-js@2` from esm.sh, Homebrew PostgreSQL for SQL tests, `deno test` for function tests.

**Spec:** `docs/superpowers/specs/2026-08-24-device-rental-design.md`

## Global Constraints

- Free tiers only. No build step for the site (plain files under `site/`).
- Borrower emails must end in `@ethz.ch`; enforced in DB trigger on `auth.users`, not only UI.
- Lab manager email is config: `LAB_MANAGER_EMAIL` (value `hongse@ethz.ch`). Never hard-code it in code; tests use a fake.
- All rental identity fields (borrower/manager/professor name+email) NOT NULL and non-blank.
- Overdue warnings every day until returned.
- Commit messages: plain, no Co-Authored-By trailers. Git identity: `skethz <pathfinder.hong@gmail.com>`.
- Repo root: `/Users/seung/Desktop/eecis-device-rental`. Run all commands from there.

## File Structure

```
supabase/
  config.toml                       # supabase CLI project config (Task 1)
  migrations/
    0001_schema.sql                 # tables, checks, exclusion constraint (Task 2)
    0002_auth_domain.sql            # @ethz.ch trigger (Task 3)
    0003_rls_and_rpc.sql            # RLS policies, mark_returned, request_extension (Task 4)
    0004_seed_devices.sql           # 35 device rows (Task 5)
    0005_webhooks_cron.sql          # pg_net webhook triggers + pg_cron schedule (Task 9)
  functions/
    _shared/
      email.ts                      # buildRequestEmail/buildDecisionEmail/... pure (Task 6)
      resend.ts                     # sendEmail(fetch, apiKey, msg) (Task 6)
      email_test.ts
    notify/index.ts                 # webhook receiver (Task 7)
    decide/index.ts                 # approve/deny link handler (Task 8)
    decide/decide_test.ts
    overdue-check/index.ts          # daily job (Task 8)
    overdue-check/overdue_test.ts
tests/
  sql/run.sh                        # loads migrations into scratch DB, runs *.sql tests (Task 2)
  sql/schema_test.sql, rls_test.sql
site/
  index.html                        # sign-in + device list (Task 10)
  request.html                      # request form (Task 10)
  my.html                           # my rentals: extend/return (Task 11)
  config.js                         # SUPABASE_URL, SUPABASE_ANON_KEY (Task 10)
  app.js                            # shared client + helpers (Task 10)
  style.css
scripts/
  seed_from_xlsx.py                 # regenerates 0004 from the xlsx (Task 5)
README.md                           # deploy/handover checklist (Task 12)
```

---

### Task 1: Tooling and repo skeleton

**Files:** Create `supabase/config.toml`, `.gitignore`, `tests/sql/run.sh`

- [ ] **Step 1: Install tools**
```bash
brew install supabase/tap/supabase postgresql@17
brew services start postgresql@17
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"; psql -d postgres -c 'select 1'
```
Expected: `1`. Deno 2 is already installed.

- [ ] **Step 2: `supabase init`** (answers: no VS Code/IntelliJ settings). Creates `supabase/config.toml`. Set in it: `[auth] site_url = "https://skethz.github.io/eecis-device-rental"`, `additional_redirect_urls = ["http://localhost:8000", "https://skethz.github.io/eecis-device-rental/**"]`, `[auth.email] enable_signup = true, double_confirm_changes = true`.

- [ ] **Step 3: `.gitignore`**
```
.env
supabase/.temp
site/config.js
.DS_Store
```
Also add `site/config.example.js` (Task 10 writes it).

- [ ] **Step 4: SQL test runner** `tests/sql/run.sh`:
```bash
#!/usr/bin/env bash
# Loads all migrations into a fresh scratch DB and runs every tests/sql/*_test.sql.
set -euo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB=eecis_test
dropdb --if-exists $DB; createdb $DB
psql -v ON_ERROR_STOP=1 -q -d $DB -f tests/sql/shim_auth.sql
for m in supabase/migrations/*.sql; do
  case "$m" in *webhooks_cron*) continue;; esac   # needs pg_net/pg_cron, cloud only
  psql -v ON_ERROR_STOP=1 -q -d $DB -f "$m"
done
for t in tests/sql/*_test.sql; do
  echo "== $t"; psql -v ON_ERROR_STOP=1 -q -d $DB -f "$t"
done
echo "SQL TESTS PASSED"
```
`tests/sql/shim_auth.sql` emulates Supabase's auth schema so migrations load on plain Postgres:
```sql
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create extension if not exists btree_gist;
```
`chmod +x tests/sql/run.sh`; run it → prints `SQL TESTS PASSED` (no tests yet).

- [ ] **Step 5: Commit** `git add -A && git commit -m "Add tooling, supabase config, SQL test runner"`

---

### Task 2: Schema migration

**Files:** Create `supabase/migrations/0001_schema.sql`, `tests/sql/schema_test.sql`

**Produces:** tables `devices`, `rentals`, `extension_requests`, `action_tokens` exactly as below; later tasks rely on these column names.

- [ ] **Step 1: Failing test** `tests/sql/schema_test.sql`
```sql
\set ON_ERROR_STOP on
begin;
insert into devices(name, maker, model, unit_no) values ('Saleae', null, null, 1);
-- blank manager name must be rejected
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
  select id, gen_random_uuid(),'A','a@ethz.ch','  ','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05' from devices;
  raise exception 'blank manager_name accepted';
exception when check_violation then null; end $$;
-- overlapping approved rentals on same device must be rejected
insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date,status)
  select id, gen_random_uuid(),'A','a@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05','approved' from devices;
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date,status)
    select id, gen_random_uuid(),'B','b@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-03','2026-09-10','approved' from devices;
  raise exception 'overlap accepted';
exception when exclusion_violation then null; end $$;
-- pending overlap is fine
insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
  select id, gen_random_uuid(),'B','b@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-03','2026-09-10' from devices;
select 'schema ok';
rollback;
```
- [ ] **Step 2: Run** `tests/sql/run.sh` → fails: relation "devices" does not exist.
- [ ] **Step 3: Migration** `supabase/migrations/0001_schema.sql`
```sql
create extension if not exists btree_gist;

create table devices (
  id bigint generated always as identity primary key,
  name text not null,
  maker text,
  model text,
  unit_no int not null,
  active boolean not null default true,
  unique (name, maker, model, unit_no)
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
```
- [ ] **Step 4: Run** `tests/sql/run.sh` → `schema ok`, `SQL TESTS PASSED`.
- [ ] **Step 5: Commit** `git commit -am "Add schema migration"` (add new files first).

---

### Task 3: ETH-only sign-up trigger

**Files:** Create `supabase/migrations/0002_auth_domain.sql`, `tests/sql/auth_test.sql`

- [ ] **Step 1: Test**
```sql
\set ON_ERROR_STOP on
begin;
insert into auth.users(email) values ('ok@ethz.ch');
insert into auth.users(email) values ('Ok2@student.ethz.ch');
do $$ begin
  insert into auth.users(email) values ('x@gmail.com');
  raise exception 'gmail accepted';
exception when others then if sqlerrm not like '%ethz.ch%' then raise; end if; end $$;
select 'auth ok';
rollback;
```
- [ ] **Step 2: Run** → fails "gmail accepted".
- [ ] **Step 3: Migration**
```sql
create or replace function public.enforce_ethz_email() returns trigger
language plpgsql security definer as $$
begin
  if new.email is null or lower(new.email) !~ '(^|@|\.)ethz\.ch$' or position('@' in new.email) = 0 then
    raise exception 'Only ethz.ch email addresses may sign in (got %)', new.email;
  end if;
  return new;
end $$;
drop trigger if exists ethz_only on auth.users;
create trigger ethz_only before insert on auth.users
  for each row execute function public.enforce_ethz_email();
```
Note: the regex must accept `@ethz.ch` and `@sub.ethz.ch` only; `x@notethz.ch` must fail — add that case to the test.
- [ ] **Step 4: Run** → `auth ok`. **Step 5: Commit** `"Restrict sign-in to ethz.ch addresses"`.

---

### Task 4: RLS policies and RPCs

**Files:** Create `supabase/migrations/0003_rls_and_rpc.sql`, `tests/sql/rls_test.sql`

**Produces:** RPC `request_extension(p_rental_id bigint, p_new_end_date date) returns bigint`, RPC `mark_returned(p_rental_id bigint) returns void`, view `device_availability(device_id, name, maker, model, unit_no, busy daterange[])`.

- [ ] **Step 1: Test** (uses `set local role authenticated; set local request.jwt.claim.sub`)
```sql
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('11111111-1111-1111-1111-111111111111','a@ethz.ch'),('22222222-2222-2222-2222-222222222222','b@ethz.ch');
insert into devices(name,unit_no) values ('Saleae',1);
set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
  select id,'11111111-1111-1111-1111-111111111111','A','a@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05' from devices;
-- cannot insert as someone else
do $$ begin
  insert into rentals(device_id,user_id,borrower_name,borrower_email,manager_name,manager_email,professor_name,professor_email,start_date,end_date)
    select id,'22222222-2222-2222-2222-222222222222','B','b@ethz.ch','M','m@ethz.ch','P','p@ethz.ch','2026-09-01','2026-09-05' from devices;
  raise exception 'spoofed user_id accepted';
exception when insufficient_privilege then null; end $$;
-- B sees nothing of A
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ declare n int; begin select count(*) into n from rentals; if n <> 0 then raise exception 'leak'; end if; end $$;
-- mark_returned on pending fails; on approved succeeds (approve as service role)
reset role; update rentals set status='approved';
set local role authenticated; set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select request_extension(id, '2026-09-08') from rentals;
do $$ begin perform request_extension((select id from rentals), '2026-09-02'); raise exception 'short extension accepted';
exception when others then if sqlerrm not like '%later than%' then raise; end if; end $$;
select mark_returned(id) from rentals;
do $$ declare s rental_status; begin select status into s from rentals; if s <> 'returned' then raise exception 'not returned'; end if; end $$;
reset role;
select count(*) as busy from device_availability where name='Saleae';
select 'rls ok';
rollback;
```
- [ ] **Step 2: Run** → fails (no RLS / functions).
- [ ] **Step 3: Migration**
```sql
alter table devices enable row level security;
alter table rentals enable row level security;
alter table extension_requests enable row level security;
alter table action_tokens enable row level security;   -- no policies: service role only

create policy devices_read on devices for select to authenticated using (true);
create policy rentals_own_read on rentals for select to authenticated using (user_id = auth.uid());
create policy rentals_own_insert on rentals for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');
create policy ext_own_read on extension_requests for select to authenticated
  using (exists (select 1 from rentals r where r.id = rental_id and r.user_id = auth.uid()));

create or replace function public.request_extension(p_rental_id bigint, p_new_end_date date)
returns bigint language plpgsql security definer set search_path = public as $$
declare r rentals; new_id bigint;
begin
  select * into r from rentals where id = p_rental_id and user_id = auth.uid();
  if r.id is null then raise exception 'rental not found'; end if;
  if r.status <> 'approved' then raise exception 'only approved rentals can be extended'; end if;
  if p_new_end_date <= r.end_date then raise exception 'new end date must be later than %', r.end_date; end if;
  if exists (select 1 from extension_requests where rental_id = r.id and status = 'pending') then
    raise exception 'an extension request is already pending'; end if;
  insert into extension_requests(rental_id, new_end_date) values (r.id, p_new_end_date) returning id into new_id;
  return new_id;
end $$;

create or replace function public.mark_returned(p_rental_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update rentals set status = 'returned', returned_at = now()
   where id = p_rental_id and user_id = auth.uid() and status = 'approved';
  if not found then raise exception 'rental not found or not approved'; end if;
end $$;

create or replace view public.device_availability with (security_invoker = false) as
  select d.id as device_id, d.name, d.maker, d.model, d.unit_no,
         coalesce(array_agg(daterange(r.start_date, r.end_date, '[]') order by r.start_date)
                  filter (where r.id is not null), '{}') as busy
    from devices d
    left join rentals r on r.device_id = d.id and r.status = 'approved' and r.end_date >= current_date
   where d.active
   group by d.id;
grant select on public.device_availability to authenticated;
grant execute on function public.request_extension(bigint, date), public.mark_returned(bigint) to authenticated;
```
- [ ] **Step 4: Run** → `rls ok`. **Step 5: Commit** `"Add RLS policies, extension/return RPCs, availability view"`.

---

### Task 5: Seed devices from the xlsx

**Files:** Create `scripts/seed_from_xlsx.py`, `supabase/migrations/0004_seed_devices.sql`, `tests/sql/seed_test.sql`

- [ ] **Step 1: Test** `tests/sql/seed_test.sql`
```sql
\set ON_ERROR_STOP on
do $$ declare n int; begin
  select count(*) into n from devices; if n <> 35 then raise exception 'expected 35 devices, got %', n; end if;
  select count(*) into n from devices where name='Saleae'; if n <> 6 then raise exception 'saleae'; end if;
  select count(*) into n from devices where name='Precision Source' and model='B2912A/B'; if n <> 4 then raise exception 'b2912'; end if;
end $$;
select 'seed ok';
```
- [ ] **Step 2: Run** → fails (0 devices).
- [ ] **Step 3: Generator** `scripts/seed_from_xlsx.py` (run with `/opt/anaconda3/bin/python3`, openpyxl present):
```python
"""Regenerate supabase/migrations/0004_seed_devices.sql from EECIS_DEVICE_LIST.xlsx."""
import openpyxl, re, sys
wb = openpyxl.load_workbook(sys.argv[1] if len(sys.argv) > 1 else "EECIS_DEVICE_LIST.xlsx", data_only=True)
ws = wb["Device List"]
rows, cur = [], None
for a, b in ws.iter_rows(min_row=3, values_only=True):
    if a:
        parts = [p.strip() for p in str(a).split("\n") if p.strip()]
        cur = (parts + [None, None])[:3]          # name, maker, model
    if b and cur:
        rows.append((*cur, int(re.search(r"\d+", str(b)).group())))
def q(v): return "null" if v is None else "'" + v.replace("'", "''") + "'"
out = ["-- generated by scripts/seed_from_xlsx.py; do not edit by hand",
       "insert into devices(name, maker, model, unit_no) values"]
out.append(",\n".join(f"  ({q(n)}, {q(m)}, {q(md)}, {u})" for n, m, md, u in rows) + "\non conflict do nothing;")
open("supabase/migrations/0004_seed_devices.sql", "w").write("\n".join(out) + "\n")
print(f"wrote {len(rows)} devices")
```
Run: `/opt/anaconda3/bin/python3 scripts/seed_from_xlsx.py` → `wrote 35 devices`. Inspect: "Analog Discovery" has maker/model null; "Farady Cage" keep spelling as in sheet.
- [ ] **Step 4: Run tests** → `seed ok`. **Step 5: Commit** `"Seed 35 devices from EECIS_DEVICE_LIST.xlsx"`.

---

### Task 6: Shared email builders and Resend client

**Files:** Create `supabase/functions/_shared/email.ts`, `_shared/resend.ts`, `_shared/email_test.ts`, `supabase/functions/deno.json`

**Produces:**
```ts
export interface Rental { id:number; borrower_name:string; borrower_email:string; manager_name:string; manager_email:string;
  professor_name:string; professor_email:string; start_date:string; end_date:string; status:string;
  device:{name:string; maker:string|null; model:string|null; unit_no:number} }
export interface Mail { to:string[]; subject:string; html:string; replyTo?:string }
export function deviceLabel(d:Rental["device"]):string            // "Saleae Nr.3" / "Precision Source Keysight B2912A/B Nr.2"
export function requestMail(r:Rental, decideUrl:string, to:string):Mail        // to lab manager, with approve/deny links
export function extensionMail(r:Rental, newEnd:string, decideUrl:string, to:string):Mail
export function decisionMail(r:Rental, kind:"rental"|"extension", approved:boolean, newEnd?:string):Mail  // to borrower
export function returnMail(r:Rental, to:string):Mail
export function overdueMail(r:Rental, labManager:string, today:string):Mail  // to borrower, manager, professor, lab manager
export async function sendEmail(fetchFn:typeof fetch, apiKey:string, from:string, mail:Mail):Promise<void>  // resend.ts, throws on non-2xx
```
`decideUrl` is the base `https://<proj>.functions.supabase.co/decide?token=<uuid>`; builders append `&action=approve` / `&action=deny`.

- [ ] **Step 1: Test** `_shared/email_test.ts`
```ts
import { assertEquals, assertStringIncludes, assertRejects } from "jsr:@std/assert";
import { deviceLabel, requestMail, overdueMail, decisionMail } from "./email.ts";
import { sendEmail } from "./resend.ts";
const r = { id:7, borrower_name:"Ana", borrower_email:"ana@ethz.ch", manager_name:"Max", manager_email:"max@ethz.ch",
  professor_name:"Prof X", professor_email:"x@ethz.ch", start_date:"2026-09-01", end_date:"2026-09-05", status:"approved",
  device:{ name:"Precision Source", maker:"Keysight", model:"B2912A/B", unit_no:2 } };
Deno.test("deviceLabel", () => {
  assertEquals(deviceLabel(r.device), "Precision Source Keysight B2912A/B Nr.2");
  assertEquals(deviceLabel({name:"Saleae",maker:null,model:null,unit_no:3}), "Saleae Nr.3");
});
Deno.test("requestMail has both links and all names", () => {
  const m = requestMail(r, "https://f/decide?token=abc", "lab@ethz.ch");
  assertEquals(m.to, ["lab@ethz.ch"]);
  assertStringIncludes(m.html, "https://f/decide?token=abc&action=approve");
  assertStringIncludes(m.html, "https://f/decide?token=abc&action=deny");
  for (const s of ["Ana","Max","Prof X","2026-09-01","2026-09-05","Nr.2"]) assertStringIncludes(m.html, s);
});
Deno.test("overdueMail goes to all four", () => {
  const m = overdueMail(r, "lab@ethz.ch", "2026-09-08");
  assertEquals(m.to, ["ana@ethz.ch","max@ethz.ch","x@ethz.ch","lab@ethz.ch"]);
  assertStringIncludes(m.subject, "OVERDUE");
});
Deno.test("decisionMail denied", () => {
  const m = decisionMail(r, "rental", false);
  assertEquals(m.to, ["ana@ethz.ch"]); assertStringIncludes(m.subject, "denied");
});
Deno.test("sendEmail posts to Resend and throws on error", async () => {
  const calls:any[] = [];
  const ok = async (u:string, i:RequestInit) => { calls.push([u,i]); return new Response("{}",{status:200}); };
  await sendEmail(ok as any, "key", "EECIS <a@b.c>", {to:["z@ethz.ch"],subject:"s",html:"<b>h</b>"});
  assertEquals(calls[0][0], "https://api.resend.com/emails");
  assertEquals(JSON.parse(calls[0][1].body).to, ["z@ethz.ch"]);
  assertEquals(calls[0][1].headers.Authorization, "Bearer key");
  const bad = async () => new Response("nope",{status:422});
  await assertRejects(() => sendEmail(bad as any, "k", "f", {to:["z@ethz.ch"],subject:"s",html:"h"}));
});
```
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-net=0.0.0.0 _shared/` → fails (module not found).
- [ ] **Step 3: Implement.** `deno.json`: `{ "imports": { "@supabase/supabase-js": "npm:@supabase/supabase-js@2" } }`.
`resend.ts`:
```ts
import type { Mail } from "./email.ts";
export async function sendEmail(fetchFn: typeof fetch, apiKey: string, from: string, mail: Mail): Promise<void> {
  const res = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: mail.to, subject: mail.subject, html: mail.html, reply_to: mail.replyTo }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
```
`email.ts`: implement the interfaces above. Rules: `esc()` HTML-escape every user field; `deviceLabel` joins non-null of name/maker/model with spaces then ` Nr.<unit_no>`; a shared `details(r)` table (device, borrower, borrower email, lab manager, professor, period, request id); `requestMail` subject `[EECIS rental] Request #7: <label> by Ana`; `extensionMail` subject `[EECIS rental] Extension request #7 ...` showing current and requested end dates; `decisionMail` subject `[EECIS rental] Your request #7 was approved|denied` (for extension, "extension request"), `replyTo` = lab manager omitted here (set by caller); `returnMail` subject `[EECIS rental] Returned: <label> by Ana`; `overdueMail` subject `[EECIS rental] OVERDUE: <label> due 2026-09-05` with body naming days overdue (`today - end_date`) and instruction to return and mark returned on the site.
- [ ] **Step 4: Run tests** → all pass. **Step 5: Commit** `"Add email builders and Resend client"`.

---

### Task 7: `notify` edge function (DB webhook receiver)

**Files:** Create `supabase/functions/notify/index.ts`, `notify/notify_test.ts`

**Consumes:** Task 6 builders. **Produces:** handler `handleNotify(payload, deps)` exported for tests; `Deno.serve` wrapper.

Webhook payload shape (Supabase Database Webhooks): `{ type:"INSERT"|"UPDATE", table:"rentals"|"extension_requests", record:{...}, old_record:{...}|null }`.
Deps: `{ db: SupabaseClient(service role), send:(mail:Mail)=>Promise<void>, labManager:string, functionsUrl:string }`.

- [ ] **Step 1: Test** — fake `db` with `from(table).select().eq().single()` returning fixtures, `from("action_tokens").insert().select().single()` returning `{token:"t1"}`. Cases: (a) rentals INSERT → one mail to labManager containing `decide?token=t1&action=approve`; (b) extension_requests INSERT → mail subject contains "Extension"; (c) rentals UPDATE with old status approved → new returned → returnMail to labManager; (d) rentals UPDATE approved→approved → no mail; (e) unknown table → 400.
- [ ] **Step 2: Run** `deno test notify/` → fails.
- [ ] **Step 3: Implement**
```ts
import { createClient } from "@supabase/supabase-js";
import { requestMail, extensionMail, returnMail, type Mail, type Rental } from "../_shared/email.ts";
import { sendEmail } from "../_shared/resend.ts";
export interface Deps { db:any; send:(m:Mail)=>Promise<void>; labManager:string; functionsUrl:string }
const RENTAL_SEL = "*, device:devices(name,maker,model,unit_no)";
async function loadRental(db:any, id:number):Promise<Rental> {
  const { data, error } = await db.from("rentals").select(RENTAL_SEL).eq("id", id).single();
  if (error) throw error; return data;
}
async function newToken(db:any, kind:string, targetId:number):Promise<string> {
  const { data, error } = await db.from("action_tokens").insert({ kind, target_id: targetId }).select("token").single();
  if (error) throw error; return data.token;
}
export async function handleNotify(p:any, d:Deps):Promise<Response> {
  if (p.table === "rentals" && p.type === "INSERT") {
    const r = await loadRental(d.db, p.record.id);
    const t = await newToken(d.db, "rental", r.id);
    await d.send(requestMail(r, `${d.functionsUrl}/decide?token=${t}`, d.labManager));
  } else if (p.table === "extension_requests" && p.type === "INSERT") {
    const r = await loadRental(d.db, p.record.rental_id);
    const t = await newToken(d.db, "extension", p.record.id);
    await d.send(extensionMail(r, p.record.new_end_date, `${d.functionsUrl}/decide?token=${t}`, d.labManager));
  } else if (p.table === "rentals" && p.type === "UPDATE" && p.old_record?.status !== "returned" && p.record.status === "returned") {
    await d.send(returnMail(await loadRental(d.db, p.record.id), d.labManager));
  } else if (p.table === "rentals" && p.type === "UPDATE") {
    return new Response("ignored", { status: 200 });
  } else return new Response("unknown event", { status: 400 });
  return new Response("ok");
}
if (import.meta.main) Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) return new Response("forbidden", { status: 403 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const from = Deno.env.get("MAIL_FROM")!, key = Deno.env.get("RESEND_API_KEY")!, lab = Deno.env.get("LAB_MANAGER_EMAIL")!;
  try {
    return await handleNotify(await req.json(), { db, labManager: lab,
      functionsUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1`,
      send: (m) => sendEmail(fetch, key, from, { ...m, replyTo: lab }) });
  } catch (e) { console.error(e); return new Response(String(e), { status: 500 }); }
});
```
- [ ] **Step 4: Run tests** → pass. **Step 5: Commit** `"Add notify edge function"`.

---

### Task 8: `decide` and `overdue-check` edge functions

**Files:** Create `supabase/functions/decide/index.ts`, `decide/decide_test.ts`, `supabase/functions/overdue-check/index.ts`, `overdue-check/overdue_test.ts`

**Produces:** `handleDecide(url:URL, deps)`, `runOverdue(deps, today:string) => Promise<number>` (count warned).

- [ ] **Step 1: Tests.** `decide_test.ts` cases: missing token → 400; token not found or `used_at` set → 410 with text "already used or invalid"; `action` not approve/deny → 400; rental approve → rentals update `{status:'approved',decided_at}`, token marked used, decisionMail sent to borrower, 200 HTML containing "approved"; rental deny → status denied; extension approve → rentals `end_date = new_end_date`, extension status approved; extension approve where db update throws exclusion error (code `23P01`) → 409 HTML "conflicts", extension stays pending, token NOT marked used; extension deny → mail says denied.
`overdue_test.ts`: db returns two approved overdue rentals (one with `last_warned_on` = today → skipped); expect 1 mail to 4 recipients; `last_warned_on` set only after successful send; send throws → not updated, function still returns 0 and does not throw.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement `decide/index.ts`**
```ts
import { createClient } from "@supabase/supabase-js";
import { decisionMail, type Mail } from "../_shared/email.ts";
import { sendEmail } from "../_shared/resend.ts";
export interface Deps { db:any; send:(m:Mail)=>Promise<void> }
const page = (title:string, body:string, status=200) =>
  new Response(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font-family:system-ui;max-width:40em;margin:3em auto"><h2>${title}</h2><p>${body}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const SEL = "*, device:devices(name,maker,model,unit_no)";
export async function handleDecide(url:URL, d:Deps):Promise<Response> {
  const token = url.searchParams.get("token"), action = url.searchParams.get("action");
  if (!token || !action) return page("Bad request", "Missing token or action.", 400);
  if (action !== "approve" && action !== "deny") return page("Bad request", "Unknown action.", 400);
  const { data: t } = await d.db.from("action_tokens").select("*").eq("token", token).is("used_at", null).maybeSingle();
  if (!t) return page("Link expired", "This link was already used or is invalid.", 410);
  const approved = action === "approve", now = new Date().toISOString();
  let rental:any, newEnd:string|undefined;
  if (t.kind === "rental") {
    const { data, error } = await d.db.from("rentals").update({ status: approved ? "approved" : "denied", decided_at: now })
      .eq("id", t.target_id).eq("status", "pending").select(SEL).single();
    if (error?.code === "23P01") return page("Conflict", "This device is already approved for an overlapping period; the request stays pending.", 409);
    if (error || !data) return page("Not found", "Request no longer pending.", 410);
    rental = data;
  } else {
    const { data: ext } = await d.db.from("extension_requests").select("*").eq("id", t.target_id).eq("status", "pending").single();
    if (!ext) return page("Not found", "Extension request no longer pending.", 410);
    newEnd = ext.new_end_date;
    if (approved) {
      const { data, error } = await d.db.from("rentals").update({ end_date: newEnd }).eq("id", ext.rental_id).select(SEL).single();
      if (error?.code === "23P01") return page("Conflict", "The extension conflicts with another approved rental; it stays pending.", 409);
      if (error) throw error; rental = data;
    } else {
      const { data } = await d.db.from("rentals").select(SEL).eq("id", ext.rental_id).single(); rental = data;
    }
    await d.db.from("extension_requests").update({ status: approved ? "approved" : "denied", decided_at: now }).eq("id", ext.id);
  }
  await d.db.from("action_tokens").update({ used_at: now }).eq("token", token);
  await d.send(decisionMail(rental, t.kind, approved, newEnd));
  return page(approved ? "Approved" : "Denied", `Request #${rental.id} ${approved ? "approved" : "denied"}; the borrower has been notified.`);
}
if (import.meta.main) Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const lab = Deno.env.get("LAB_MANAGER_EMAIL")!;
  try { return await handleDecide(new URL(req.url), { db, send: (m) => sendEmail(fetch, Deno.env.get("RESEND_API_KEY")!, Deno.env.get("MAIL_FROM")!, { ...m, replyTo: lab }) }); }
  catch (e) { console.error(e); return page("Error", String(e), 500); }
});
```
`decide` must be deployed with `--no-verify-jwt` (it's opened from an email).
`overdue-check/index.ts`:
```ts
import { createClient } from "@supabase/supabase-js";
import { overdueMail, type Mail } from "../_shared/email.ts";
import { sendEmail } from "../_shared/resend.ts";
export interface Deps { db:any; send:(m:Mail)=>Promise<void>; labManager:string }
export async function runOverdue(d:Deps, today:string):Promise<number> {
  const { data, error } = await d.db.from("rentals").select("*, device:devices(name,maker,model,unit_no)")
    .eq("status", "approved").lt("end_date", today).or(`last_warned_on.is.null,last_warned_on.lt.${today}`);
  if (error) throw error;
  let n = 0;
  for (const r of data ?? []) {
    try { await d.send(overdueMail(r, d.labManager, today)); }
    catch (e) { console.error(`warn failed for rental ${r.id}`, e); continue; }
    await d.db.from("rentals").update({ last_warned_on: today }).eq("id", r.id); n++;
  }
  return n;
}
if (import.meta.main) Deno.serve(async (req) => {
  if (req.headers.get("authorization") !== `Bearer ${Deno.env.get("CRON_SECRET")}`) return new Response("forbidden", { status: 403 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const lab = Deno.env.get("LAB_MANAGER_EMAIL")!;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date()); // YYYY-MM-DD
  const n = await runOverdue({ db, labManager: lab, send: (m) => sendEmail(fetch, Deno.env.get("RESEND_API_KEY")!, Deno.env.get("MAIL_FROM")!, { ...m, replyTo: lab }) }, today);
  return Response.json({ warned: n });
});
```
- [ ] **Step 4: Run** `deno test` (all dirs) → pass. **Step 5: Commit** `"Add decide and overdue-check edge functions"`.

---

### Task 9: Webhook triggers and cron schedule (cloud-only migration)

**Files:** Create `supabase/migrations/0005_webhooks_cron.sql`

This runs only on Supabase (needs `pg_net`, `pg_cron`, and Vault secrets); the SQL test runner skips it. Secrets are read from Vault so nothing sensitive is in git.

- [ ] **Step 1: Write migration**
```sql
create extension if not exists pg_net;
create extension if not exists pg_cron;
-- Owner must run once in SQL editor before applying:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'functions_url');
--   select vault.create_secret('<random>', 'webhook_secret');
--   select vault.create_secret('<random>', 'cron_secret');
create or replace function public.call_notify() returns trigger language plpgsql security definer as $$
declare url text; secret text;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'webhook_secret';
  perform net.http_post(
    url := url || '/notify',
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret',secret),
    body := jsonb_build_object('type', tg_op, 'table', tg_table_name,
              'record', to_jsonb(new), 'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end));
  return new;
end $$;
create trigger rentals_notify after insert or update of status on rentals for each row execute function public.call_notify();
create trigger ext_notify after insert on extension_requests for each row execute function public.call_notify();

select cron.schedule('overdue-check', '0 6 * * *',   -- 06:00 UTC = 08:00 Zurich (07:00 in winter)
$$ select net.http_post(
     url := (select decrypted_secret from vault.decrypted_secrets where name='functions_url') || '/overdue-check',
     headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cron_secret'))) $$);
```
- [ ] **Step 2: Verify** `tests/sql/run.sh` still passes (file skipped). **Step 3: Commit** `"Add webhook triggers and daily overdue cron"`.

---

### Task 10: Site — sign-in, device list, request form

**Files:** Create `site/index.html`, `site/request.html`, `site/app.js`, `site/style.css`, `site/config.example.js`

**Consumes:** `device_availability` view, `rentals` insert policy. Test: manual in browser against the deployed Supabase project (no JS unit test framework; keep logic in `app.js` small). Serve locally with `python3 -m http.server 8000 -d site`.

- [ ] **Step 1: `config.example.js`** `export const SUPABASE_URL = "https://YOUR_REF.supabase.co"; export const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";` — copy to `config.js` (gitignored). Note: since the site is public, `config.js` must be committed for Pages; the anon key is public by design. So instead: **do not gitignore `config.js`**; remove it from `.gitignore` and commit the real values in Task 12.
- [ ] **Step 2: `app.js`**
```js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export async function requireUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.href = "./index.html"; throw new Error("not signed in"); }
  return session.user;
}
export function deviceLabel(d) { return [d.name, d.maker, d.model].filter(Boolean).join(" ") + ` Nr.${d.unit_no}`; }
export function isEthz(email) { return /(^|@|\.)ethz\.ch$/i.test(email) && email.includes("@"); }
export function overlaps(busy, start, end) {           // busy: ["[2026-09-01,2026-09-06)", ...] (Postgres daterange text)
  return busy.some(r => { const m = r.match(/\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)/); return m && start < m[2] && end >= m[1]; });
}
export const $ = (s) => document.querySelector(s);
```
- [ ] **Step 3: `index.html`** — header "EECIS Device Rental"; if signed out: email input + "Send sign-in link" (client checks `isEthz`, calls `sb.auth.signInWithOtp({email, options:{emailRedirectTo: location.href}})`, shows "Check your email"); if signed in: show email, links to *My rentals* and *Sign out*, and a table from `device_availability` (label, "Available"/"Busy until <date>" computed from `busy` vs today, "Request" button → `request.html?device=<id>`).
- [ ] **Step 4: `request.html`** — form fields: device (select prefilled from `?device=`), start date, end date, your name, your lab manager name, lab manager email, professor name, professor email. Borrower email shown read-only from session. Submit button `disabled` until every field non-blank, emails valid, `end >= start`, and no `overlaps()` (show inline reason). On submit: `sb.from("rentals").insert({...,user_id:user.id, borrower_email:user.email})`; on success show "Request sent to the lab manager; you'll get an email when it's decided" and link to `my.html`; on error show the message.
- [ ] **Step 5: `style.css`** — minimal: system font, max-width 60em, table borders, `.busy{color:#b00}`, `.ok{color:#080}`, `button:disabled{opacity:.5}`.
- [ ] **Step 6: Manual test** with local server: unsigned → form redirect works; blank field keeps Submit disabled. **Step 7: Commit** `"Add site: sign-in, device list, request form"`.

---

### Task 11: Site — My rentals (extend / return)

**Files:** Create `site/my.html`

- [ ] **Step 1: Page** lists own rentals (`sb.from("rentals").select("*, device:devices(name,maker,model,unit_no)").order("created_at",{ascending:false})`) with status badge; pending extension shown ("extension to <date> pending") from `extension_requests`. For `approved` rows: date input + "Request extension" → `sb.rpc("request_extension",{p_rental_id:id,p_new_end_date:date})`; "Mark returned" (confirm dialog) → `sb.rpc("mark_returned",{p_rental_id:id})`. Show RPC error messages inline; reload list after success. Overdue rows (end_date < today, approved) highlighted `.busy` with "OVERDUE".
- [ ] **Step 2: Manual test** later in Task 12 E2E. **Step 3: Commit** `"Add my rentals page with extension and return"`.

---

### Task 12: Deploy, GitHub Pages, end-to-end run, README

**Files:** Create `README.md`, `site/config.js`; Modify `.gitignore`

Owner-only steps are marked **(owner)**; the agent performs the rest.

- [ ] **Step 1 (owner):** create Supabase project (region eu-central), Resend account + API key. Provide: project ref, DB password, Resend key, `supabase login`.
- [ ] **Step 2:** `supabase link --project-ref <ref>`; `supabase db push`; in SQL editor create the three Vault secrets from Task 9; apply 0005.
- [ ] **Step 3:** `supabase secrets set RESEND_API_KEY=… MAIL_FROM="EECIS Rental <onboarding@resend.dev>" LAB_MANAGER_EMAIL=hongse@ethz.ch WEBHOOK_SECRET=… CRON_SECRET=…`; `supabase functions deploy notify --no-verify-jwt`, `decide --no-verify-jwt`, `overdue-check --no-verify-jwt`.
- [ ] **Step 4:** Dashboard → Auth → URL config: site URL + redirect `https://skethz.github.io/eecis-device-rental/**`; email provider enabled (magic link). Write `site/config.js` with URL + anon key, remove it from `.gitignore`, commit.
- [ ] **Step 5:** `gh repo create skethz/eecis-device-rental --public --source . --push`; `gh api -X POST repos/skethz/eecis-device-rental/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/site'` — if the API refuses `/site`, add a GitHub Actions `pages.yml` that uploads `site/` (actions/upload-pages-artifact + deploy-pages).
- [ ] **Step 6: E2E (owner + agent):** sign in with an ethz.ch address → request Saleae Nr.1 → approve link in hongse@ethz.ch → borrower gets approval mail → request extension → approve → set `end_date` to yesterday in table editor → `curl -H "Authorization: Bearer $CRON_SECRET" .../overdue-check` → 4-recipient warning arrives → mark returned → return mail arrives. Record outcomes in README "Verified on <date>".
- [ ] **Step 7: README** — what it is, how the flows work, the owner checklist (secrets, Vault, Pages), how to edit inventory (Supabase table editor or rerun `scripts/seed_from_xlsx.py` + `supabase db push`), how to change lab manager email (`supabase secrets set LAB_MANAGER_EMAIL=…`), how to run tests (`tests/sql/run.sh`, `cd supabase/functions && deno test`).
- [ ] **Step 8: Commit and push** `"Add README and deployment config"`.
