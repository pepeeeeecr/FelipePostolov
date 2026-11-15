-- Owner dashboard (Manage > Dashboard). Run once in the Supabase SQL Editor.
-- Until it's run the dashboard still works: sign-ups are counted from the
-- consent date, and every report / event request counts as open.

-- When each person first created their profile (milliseconds, like
-- updated_at). Existing rows get their consent date, or their last update.
alter table users add column if not exists created_at bigint;
update users set created_at = coalesce(terms_agreed_at, updated_at) where created_at is null;

-- "Mark handled" on reports and event requests.
alter table user_reports add column if not exists resolved_at timestamptz;
alter table event_requests add column if not exists handled_at timestamptz;
