-- Foursome backend: stop public reads of the ratings table
-- Run this in Supabase Dashboard > SQL Editor > New query, after
-- supabase-lock-users-teetimes.sql.
--
-- Why: supabase-enable-rls.sql made SELECT on ratings public. Every rating
-- row carries teetime_id + rater_id + ratee_id, so the anon key could list
-- who played in which round — the same participant ids /api/teetimes no
-- longer exposes. Neither app reads ratings directly (averages and a
-- round's ratings come from the backend, which uses service_role and
-- bypasses RLS), so nothing on any screen depends on this policy.
--
-- What this does NOT touch: RLS stays enabled, the existing ratings
-- insert/update/delete policies are unchanged (a rater still matches the
-- SELECT policy below, which UPDATE/DELETE need), and no function or grant
-- is redefined.

alter table ratings enable row level security;

drop policy if exists "ratings_select_public" on ratings;
drop policy if exists "ratings_select_own" on ratings;
create policy "ratings_select_own" on ratings for select to authenticated
  using (auth.uid()::text = rater_id or auth.uid()::text = ratee_id);

-- --- Check ------------------------------------------------------------------
-- Should list ratings_select_own / _insert_own / _update_own / _delete_own.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'ratings'
order by policyname;
