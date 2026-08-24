# EECIS Device Rental System — Design

Date: 2026-08-24. Owner: Seung Hong (lab manager, Prof. Taekwang's group), hongse@ethz.ch.

## Purpose
Replace the "Rental Record" sheet in `EECIS_DEVICE_LIST.xlsx` with a free website where members of other groups request to borrow EECIS devices, request extensions, report returns, and are automatically warned when overdue.

## Stack (all free tiers)
- **Frontend:** static HTML/JS on GitHub Pages, repo `skethz/eecis-device-rental`. Supabase JS client via ESM CDN. No build step.
- **Backend:** Supabase — Postgres, Auth (email magic link), Row-Level Security, Edge Functions (Deno), `pg_cron` + `pg_net` for the daily job.
- **Email:** Resend (3,000/month). Sender is a Resend-verified address (initially `onboarding@resend.dev`), `Reply-To: hongse@ethz.ch`. Lab manager address is a config value `LAB_MANAGER_EMAIL=hongse@ethz.ch`.

## Users
- **Borrower:** any `@ethz.ch` address. Signs in by magic link. Domain restriction enforced by a `before user created` auth hook / trigger, not only in the UI.
- **Lab manager (admin):** does not log in. Acts through single-use tokenised Approve/Deny links in email.

## Data model
```
devices(id, name, maker, model, unit_no, active bool)        -- 35 rows seeded from xlsx
rentals(id, device_id, user_id, borrower_name, borrower_email,
        manager_name, manager_email, professor_name, professor_email,
        start_date, end_date, status, created_at, decided_at,
        returned_at, last_warned_on)
  status ∈ pending | approved | denied | returned
extension_requests(id, rental_id, new_end_date, status, created_at, decided_at)
  status ∈ pending | approved | denied
action_tokens(token uuid pk, kind, target_id, used_at, created_at)
  kind ∈ rental | extension
```
Constraints: all name/email fields NOT NULL and non-blank (CHECK); `end_date >= start_date`; exclusion constraint prevents two `approved` rentals of the same device with overlapping `[start_date, end_date]`.

RLS: borrowers `select/insert` own rentals and extension requests (`user_id = auth.uid()`), may `update` own approved rental only to set `status='returned'` (via RPC `mark_returned`). Devices readable by authenticated users. Tokens and admin actions only via edge functions using the service role key.

## Flows
1. **Request.** Sign in → Devices page shows each unit with availability (busy ranges from approved rentals) → Request form: device, start/end, borrower name, manager name+email, professor name+email (borrower email = login email). Submit disabled until all filled and valid; DB CHECKs are the real guard. Insert → DB webhook calls edge function `notify-request` → email to lab manager with details + Approve/Deny links (`/functions/v1/decide?token=…&action=approve|deny`). Borrower gets an email on decision.
2. **Extension.** My rentals → "Request extension" with new end date (> current end) → insert `extension_requests` → same email pattern to lab manager. On approve: `rentals.end_date` updated (overlap constraint re-checked; on conflict the approval fails and the manager gets an error page).
3. **Return.** My rentals → "Mark returned" → RPC sets status `returned`, `returned_at` → edge function emails lab manager.
4. **Overdue.** `pg_cron` daily 08:00 Europe/Zurich → edge function `overdue-check`: for each rental with `status='approved' AND end_date < current_date AND (last_warned_on IS NULL OR last_warned_on < current_date)` send warning to borrower, manager, professor, lab manager; set `last_warned_on`. Repeats every day until returned.

## Edge functions
- `notify-request` (webhook on rentals/extension_requests insert, and on return) — builds email, creates token, sends via Resend.
- `decide` (GET, public) — validates token (exists, unused), applies decision, marks token used, emails borrower, returns a small HTML confirmation page.
- `overdue-check` (called by pg_cron with a shared secret).

## Error handling
- Invalid/used token → 410 page "link already used or invalid".
- Overlap on approval → 409 page explaining the conflict; rental stays pending.
- Resend failure → function returns 500, logged; the DB write already succeeded so nothing is lost; overdue rows are not marked warned on failure so they retry next day.

## Testing
- SQL migrations + RLS tests run against local Supabase (`supabase start`, `supabase test db`).
- Edge functions: Deno unit tests with a mocked Resend and Supabase client (`deno test`).
- Manual end-to-end with real addresses before handover.

## Out of scope
Admin dashboard, multi-device requests, password login, inventory UI (edit `devices` in Supabase table editor), sending from `@ethz.ch` (needs DNS).

## Handover checklist (things only the owner can do)
1. Create Supabase project; run migrations; set secrets `RESEND_API_KEY`, `LAB_MANAGER_EMAIL`, `CRON_SECRET`, `SITE_URL`.
2. Create Resend account and API key (optionally verify a domain).
3. Enable GitHub Pages on `main` `/site`.
4. Put Supabase URL + anon key into `site/config.js`.
