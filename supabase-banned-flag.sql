-- Foursome backend: moderation "banned" flag
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations.
--
-- This is a pure additive column — it does not touch migrate_guest_to_user,
-- RLS, or any grants, so it can't undo the auth.uid() ownership check or
-- the RLS lockdown from earlier migrations. (If you ever do need to edit
-- migrate_guest_to_user again: base it on supabase-fix-migrate-guest-
-- regression.sql's version, which has the auth.uid() check — never on an
-- older copy.)
--
-- How to ban someone (Table Editor, no SQL needed):
--   1. Supabase Dashboard > Table Editor > "users" table.
--   2. Find their row (search by name or user_id — user_id is also what
--      shows in any report you get emailed).
--   3. Click the "banned" cell, set it to true, save.
-- That's it — the backend checks this on every write (posting, joining,
-- messaging, rating) and filters their rounds/profile out of what other
-- users see, within a few seconds (no caching). Set it back to false to
-- unban.
alter table users add column if not exists banned boolean not null default false;

create index if not exists idx_users_banned on users (banned) where banned;
