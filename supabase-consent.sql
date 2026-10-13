-- Foursome backend: record Terms of Service / Privacy Policy consent
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations.
--
-- Captured once, when someone checks the consent box at the welcome gate
-- (before they can sign up, log in, or continue as a guest), and sent up
-- with the first POST /api/profiles call — the same moment a users row is
-- first created. Never overwritten after that: editing a profile later
-- doesn't touch these columns.
alter table users add column if not exists terms_agreed_at bigint;
alter table users add column if not exists terms_policy_version text;

-- Guest -> account migration should carry the guest's consent record over
-- if the real account doesn't already have one of its own, same pattern as
-- is_pro/stripe_customer_id below. Redefines the function in full (as every
-- migration touching it does) — this is supabase-fix-security-definer.sql's
-- version (the one with the auth.uid() ownership check — do NOT drop that
-- check by basing a future edit of this function on an older copy; see
-- supabase-fix-migrate-guest-regression.sql for what happens when you do)
-- plus the two coalesce lines for consent.
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

  -- Blocks made BY the guest: move to the auth id, unless the auth account
  -- already blocks that same person (then just drop the guest's duplicate).
  update blocks b
  set blocker_id = p_auth_id
  where b.blocker_id = p_guest_id
    and not exists (
      select 1 from blocks b2 where b2.blocker_id = p_auth_id and b2.blocked_id = b.blocked_id
    );
  delete from blocks where blocker_id = p_guest_id; -- any left over were duplicates

  -- Blocks made AGAINST the guest: same idea, other column.
  update blocks b
  set blocked_id = p_auth_id
  where b.blocked_id = p_guest_id
    and not exists (
      select 1 from blocks b2 where b2.blocked_id = p_auth_id and b2.blocker_id = b.blocker_id
    );
  delete from blocks where blocked_id = p_guest_id;

  -- Guard against a leftover self-block if the guest and the auth account
  -- had blocked each other before this migration.
  delete from blocks where blocker_id = blocked_id;

  update user_reports set reporter_id = p_auth_id where reporter_id = p_guest_id;
  update user_reports set reported_id = p_auth_id where reported_id = p_guest_id;
  delete from user_reports where reporter_id = reported_id;
end;
$$;

revoke execute on function migrate_guest_to_user(text, text) from public, anon, authenticated;
grant execute on function migrate_guest_to_user(text, text) to service_role, authenticated;
