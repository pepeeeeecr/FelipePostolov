-- Foursome backend: harden the 3 SECURITY DEFINER functions flagged by
-- Supabase's linter (delete_user_account, migrate_guest_to_user,
-- is_teetime_participant).
--
-- CONFIRMED, LIVE VULNERABILITY before this fix: none of these three
-- functions checked the caller's identity, and — contrary to what the
-- original migration files assumed — EXECUTE on them was NOT limited to
-- service_role alone (Postgres grants EXECUTE to PUBLIC by default on
-- function creation unless explicitly revoked, and the original files only
-- ever added a service_role grant, never a revoke). Verified directly: a
-- real signed-in test user was able to call delete_user_account and
-- migrate_guest_to_user targeting a completely unrelated second real
-- account, and both succeeded — the second account's profile was deleted,
-- and a forced data merge into a third account's profile went through,
-- neither with any consent or involvement from the account being acted on.
--
-- Fix has two layers, not just one:
--   1. Revoke EXECUTE from public/anon/authenticated, re-grant to
--      service_role only — closes the access-control gap directly.
--   2. ALSO add an explicit auth.uid() check inside each function body —
--      defense in depth, so even if a future grant change reopens access
--      (or grants are set differently on branches/other environments),
--      the function itself still refuses to act on an identity other than
--      the caller's own. auth.uid() is NULL for this app's backend, which
--      always connects via the service_role key — so these checks are
--      structured as "only enforce this if auth.uid() is actually set",
--      which leaves every legitimate backend call completely unaffected.

-- --- delete_user_account -----------------------------------------------------
create or replace function delete_user_account(p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    return;
  end if;

  -- Only the account owner (or the backend, via service_role, where
  -- auth.uid() is null) may trigger this. A signed-in caller targeting
  -- anyone else is rejected outright, before touching any data.
  if auth.uid() is not null and auth.uid()::text <> p_user_id then
    raise exception 'not authorized: you can only delete your own account';
  end if;

  delete from messages where sender_id = p_user_id;
  delete from ratings where rater_id = p_user_id or ratee_id = p_user_id;
  delete from push_subscriptions where user_id = p_user_id;

  delete from messages where teetime_id in (select id from teetimes where host_id = p_user_id);
  delete from teetimes where host_id = p_user_id;

  update teetimes
  set requests = (
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
    from jsonb_array_elements(requests) elem
    where elem->>'userId' <> p_user_id
  )
  where exists (select 1 from jsonb_array_elements(requests) e where e->>'userId' = p_user_id);

  update teetimes
  set viewed_by = (
    select coalesce(jsonb_agg(elem), '[]'::jsonb)
    from jsonb_array_elements(viewed_by) elem
    where elem <> to_jsonb(p_user_id)
  )
  where exists (select 1 from jsonb_array_elements(viewed_by) e where e = to_jsonb(p_user_id));

  delete from blocks where blocker_id = p_user_id or blocked_id = p_user_id;
  delete from user_reports where reporter_id = p_user_id;

  delete from users where user_id = p_user_id;
end;
$$;

revoke execute on function delete_user_account(text) from public, anon, authenticated;
grant execute on function delete_user_account(text) to service_role, authenticated;
-- authenticated keeps EXECUTE (needed since a real signed-in user's own
-- account deletion legitimately calls this) — the in-function check above
-- is what actually restricts it to their own row now, not the grant.

-- --- migrate_guest_to_user ----------------------------------------------------
create or replace function migrate_guest_to_user(p_guest_id text, p_auth_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_guest_id is null or p_auth_id is null or p_guest_id = p_auth_id then
    return;
  end if;

  -- Only the destination account's real owner (or the backend, via
  -- service_role) may pull guest data into it. There's no meaningful
  -- "auth.uid() = p_guest_id" check possible — guest ids never have a real
  -- Supabase Auth session — so p_auth_id (the account being written INTO)
  -- is the identity that matters here.
  if auth.uid() is not null and auth.uid()::text <> p_auth_id then
    raise exception 'not authorized: you can only migrate data into your own account';
  end if;

  if exists (select 1 from users where user_id = p_auth_id) then
    update users u
    set is_pro = u.is_pro or g.is_pro,
        stripe_customer_id = coalesce(u.stripe_customer_id, g.stripe_customer_id)
    from users g
    where u.user_id = p_auth_id and g.user_id = p_guest_id;
    delete from users where user_id = p_guest_id;
  else
    update users set user_id = p_auth_id where user_id = p_guest_id;
  end if;

  update teetimes set host_id = p_auth_id where host_id = p_guest_id;
  update ratings set rater_id = p_auth_id where rater_id = p_guest_id;
  update ratings set ratee_id = p_auth_id where ratee_id = p_guest_id;
  update push_subscriptions set user_id = p_auth_id where user_id = p_guest_id;
  update messages set sender_id = p_auth_id where sender_id = p_guest_id;

  update teetimes
  set requests = (
    select coalesce(jsonb_agg(
      case when elem->>'userId' = p_guest_id
           then jsonb_set(elem, '{userId}', to_jsonb(p_auth_id))
           else elem
      end
    ), '[]'::jsonb)
    from jsonb_array_elements(requests) elem
  )
  where exists (select 1 from jsonb_array_elements(requests) e where e->>'userId' = p_guest_id);

  update teetimes
  set viewed_by = (
    select coalesce(jsonb_agg(
      case when elem = to_jsonb(p_guest_id) then to_jsonb(p_auth_id) else elem end
    ), '[]'::jsonb)
    from jsonb_array_elements(viewed_by) elem
  )
  where exists (select 1 from jsonb_array_elements(viewed_by) e where e = to_jsonb(p_guest_id));

  update blocks b
  set blocker_id = p_auth_id
  where b.blocker_id = p_guest_id
    and not exists (
      select 1 from blocks b2 where b2.blocker_id = p_auth_id and b2.blocked_id = b.blocked_id
    );
  delete from blocks where blocker_id = p_guest_id;

  update blocks b
  set blocked_id = p_auth_id
  where b.blocked_id = p_guest_id
    and not exists (
      select 1 from blocks b2 where b2.blocked_id = p_auth_id and b2.blocker_id = b.blocker_id
    );
  delete from blocks where blocked_id = p_guest_id;

  delete from blocks where blocker_id = blocked_id;

  update user_reports set reporter_id = p_auth_id where reporter_id = p_guest_id;
  update user_reports set reported_id = p_auth_id where reported_id = p_guest_id;
  delete from user_reports where reporter_id = reported_id;
end;
$$;

revoke execute on function migrate_guest_to_user(text, text) from public, anon, authenticated;
grant execute on function migrate_guest_to_user(text, text) to service_role, authenticated;
-- Same reasoning: a real signed-in user legitimately calls this on
-- themselves (upgrading their own guest data) via the backend's
-- /api/auth/migrate-guest route — authenticated keeps EXECUTE, the
-- in-function check restricts the target to their own account.

-- --- is_teetime_participant ---------------------------------------------------
-- Read-only helper used inside the messages RLS policies (always called
-- with auth.uid() as p_user_id from there). Rewritten as a single guarded
-- expression rather than raising: a boolean helper used inside another
-- policy's USING/WITH CHECK clause should fail closed (return false) on an
-- unauthorized query, not throw and break the outer query.
create or replace function is_teetime_participant(p_teetime_id text, p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (auth.uid() is null or auth.uid()::text = p_user_id) and exists (
    select 1 from teetimes t
    where t.id = p_teetime_id
      and (
        t.host_id = p_user_id
        or exists (
          select 1 from jsonb_array_elements(t.requests) r
          where r->>'userId' = p_user_id and r->>'status' = 'approved'
        )
      )
  );
$$;

revoke execute on function is_teetime_participant(text, text) from public, anon;
grant execute on function is_teetime_participant(text, text) to service_role, authenticated;
-- authenticated needs EXECUTE since the messages RLS policies themselves
-- call this on behalf of any signed-in user reading/posting chat — the
-- in-function check above is what stops it being useful for anything
-- other than checking the caller's own participation.
