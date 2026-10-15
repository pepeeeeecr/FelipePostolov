-- Foursome backend: stop public reads of the users and teetimes tables
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations (after supabase-enable-rls.sql).
--
-- Why: supabase-enable-rls.sql made SELECT on users and teetimes public
-- (using (true)), on the theory that the same fields are shown in the app
-- anyway. In practice that let anyone holding the publishable/anon key read
-- every users row directly — including banned, stripe_customer_id and the
-- terms-consent timestamps, none of which the app ever shows — and every
-- teetimes row's viewed_by list.
--
-- Neither app reads these tables directly: the Expo app and public/index.html
-- only use the Supabase client for auth (sign-up, login, session), and every
-- profile/round read goes through this backend, which uses the service_role
-- key and bypasses RLS. So nothing on any screen depends on these policies.
--
-- What this does NOT touch: RLS stays enabled on every table, every
-- insert/update/delete policy from supabase-enable-rls.sql is unchanged, and
-- no function or grant is redefined — so the auth.uid() checks in
-- delete_user_account / migrate_guest_to_user and the banned column are
-- exactly as they were.

alter table users enable row level security;
alter table teetimes enable row level security;

-- --- users --------------------------------------------------------------
-- A signed-in user can read only their own row; anon gets nothing (no
-- policy for anon = no rows). The backend still reads everything via
-- service_role.
drop policy if exists "users_select_public" on users;
drop policy if exists "users_select_own" on users;
create policy "users_select_own" on users for select to authenticated
  using (auth.uid()::text = user_id);

-- --- teetimes -----------------------------------------------------------
-- Public browsing (Discover) is served by the backend's /api/teetimes, so
-- direct reads are limited to the host's own rounds — which also keeps the
-- existing host-only update/delete policies working, since Postgres needs a
-- row to be SELECT-visible before an UPDATE/DELETE policy can match it.
-- Anon gets nothing, viewed_by included.
drop policy if exists "teetimes_select_public" on teetimes;
drop policy if exists "teetimes_select_own" on teetimes;
create policy "teetimes_select_own" on teetimes for select to authenticated
  using (auth.uid()::text = host_id);

-- --- Check ------------------------------------------------------------------
-- Should list users_select_own / users_insert_own / users_update_own and
-- teetimes_select_own / _insert_own / _update_own / _delete_own, with
-- rowsecurity = true for both tables.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('users', 'teetimes')
order by tablename, policyname;

select relname, relrowsecurity as rowsecurity
from pg_class
where relname in ('users', 'teetimes') and relnamespace = 'public'::regnamespace;
