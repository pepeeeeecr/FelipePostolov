-- Foursome backend: Auth support
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- the earlier supabase-migration.sql (this is additive — it doesn't touch
-- existing tables).
--
-- Note on naming: Supabase Auth keeps its own "auth.users" table (email,
-- password hash, etc.) in a separate "auth" schema. It has nothing to do
-- with our own "public.users" table (golf profiles) — no collision, no
-- migration of that table's shape needed. A signed-in person's identity is
-- just their auth.users.id (a UUID), used exactly where a guest's
-- "u_xxxxx" string was used before — user_id stays a plain text column.

-- Folds a guest's data (everything keyed by their locally-generated guest
-- id) into their real account once they sign up or log in. Runs as a single
-- function so it's atomic — either everything moves over, or nothing does.
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

  -- Profile row: move it, or if the auth account already has one (e.g.
  -- they'd logged in before on another device), merge in what the guest
  -- profile adds without clobbering the existing one.
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

  -- The guest id can also appear inside teetimes.requests (a JSONB array of
  -- { userId, name, handicap, status }) on rounds hosted by someone else —
  -- rewrite it wherever it shows up, not just on rounds the guest hosted.
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

  -- Same idea for viewedBy (a JSONB array of plain userId strings).
  update teetimes
  set viewed_by = (
    select coalesce(jsonb_agg(
      case when elem = to_jsonb(p_guest_id) then to_jsonb(p_auth_id) else elem end
    ), '[]'::jsonb)
    from jsonb_array_elements(viewed_by) elem
  )
  where exists (select 1 from jsonb_array_elements(viewed_by) e where e = to_jsonb(p_guest_id));
end;
$$;

-- The server calls this with the service-role key, which already bypasses
-- RLS — this grant just documents intent and covers any future non-service
-- caller.
grant execute on function migrate_guest_to_user(text, text) to service_role;
