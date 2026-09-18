-- Foursome backend: account deletion
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- the earlier supabase-migration.sql and supabase-auth-setup.sql.

-- Permanently removes a user's data. Runs as a single function so it's
-- atomic. Mirrors migrate_guest_to_user's approach to rewriting the
-- requests/viewed_by JSONB arrays, except here matching entries are
-- filtered OUT instead of renamed.
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

  -- Messages they sent, in any round's chat.
  delete from messages where sender_id = p_user_id;

  -- Ratings they gave or received.
  delete from ratings where rater_id = p_user_id or ratee_id = p_user_id;

  delete from push_subscriptions where user_id = p_user_id;

  -- Rounds they hosted go away entirely, along with whatever chat history
  -- is left for them (their own messages were already deleted above).
  delete from messages where teetime_id in (select id from teetimes where host_id = p_user_id);
  delete from teetimes where host_id = p_user_id;

  -- On rounds hosted by someone else, drop their entries from requests and
  -- viewedBy rather than touching the round itself.
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

  delete from users where user_id = p_user_id;
end;
$$;

grant execute on function delete_user_account(text) to service_role;
