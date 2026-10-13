-- Foursome backend: URGENT — restores the auth.uid() ownership check on
-- migrate_guest_to_user that supabase-consent.sql accidentally removed.
-- Run this in Supabase Dashboard > SQL Editor > New query IMMEDIATELY.
--
-- What happened: supabase-fix-security-definer.sql added an auth.uid()
-- check to migrate_guest_to_user (closing a confirmed vulnerability where
-- any signed-in user could force-merge an arbitrary other account's data
-- into their own). supabase-consent.sql later did `create or replace
-- function migrate_guest_to_user(...)` from an older copy of the function
-- (to add the two terms_agreed_at/terms_policy_version coalesce lines) —
-- CREATE OR REPLACE replaces the whole function body, so that silently
-- deleted the auth.uid() check again. Grants were unaffected (anon/public
-- are still correctly revoked from an earlier run), but any authenticated
-- user can currently call this targeting someone else's account. This file
-- is supabase-fix-security-definer.sql's migrate_guest_to_user, with the
-- consent-column coalesce lines from supabase-consent.sql re-added on top
-- — nothing removed this time.
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
        stripe_customer_id = coalesce(u.stripe_customer_id, g.stripe_customer_id),
        terms_agreed_at = coalesce(u.terms_agreed_at, g.terms_agreed_at),
        terms_policy_version = coalesce(u.terms_policy_version, g.terms_policy_version)
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

-- Redundant if grants already survived intact (CREATE OR REPLACE doesn't
-- touch them), but included so this file is correct on its own regardless
-- of current state.
revoke execute on function migrate_guest_to_user(text, text) from public, anon, authenticated;
grant execute on function migrate_guest_to_user(text, text) to service_role, authenticated;
