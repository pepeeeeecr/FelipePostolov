-- Foursome backend: safety/social features (played-together, blocking, reporting)
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations.
--
-- "Mutual rounds played together" needs no new table — it's computed on the
-- fly from existing teetimes/requests data (see server.js's
-- getPlayedTogetherCount). This file adds the two things that DO need
-- storage: blocks and reports.

create table if not exists blocks (
  id bigint generated always as identity primary key,
  blocker_id text not null,
  blocked_id text not null,
  created_at bigint not null,
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists idx_blocks_blocker_id on blocks (blocker_id);
create index if not exists idx_blocks_blocked_id on blocks (blocked_id);

create table if not exists user_reports (
  id bigint generated always as identity primary key,
  reporter_id text not null,
  reported_id text not null,
  reason text not null,
  created_at bigint not null,
  check (reporter_id <> reported_id)
);

create index if not exists idx_user_reports_reported_id on user_reports (reported_id);
create index if not exists idx_user_reports_reporter_id on user_reports (reporter_id);

-- RLS left disabled, same as every other table — only the service_role key
-- ever talks to Supabase directly (see supabase-migration.sql's note).

-- --- Guest migration: fold blocks/reports the guest made or received into
-- their real account, same approach as every other table in this function.
-- Blocks have a unique(blocker_id, blocked_id) constraint, so a rename could
-- collide with a block the auth account already has in the same direction —
-- skip those instead of erroring, then drop whatever's left under the old id.
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

grant execute on function migrate_guest_to_user(text, text) to service_role;

-- --- Account deletion: also clean up blocks both ways (a block relationship
-- is meaningless once either party is gone). Reports THEY FILED are deleted
-- as their own data, but reports filed AGAINST them are kept — a moderation/
-- safety record shouldn't disappear just because the reported person deleted
-- their account.
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

grant execute on function delete_user_account(text) to service_role;
