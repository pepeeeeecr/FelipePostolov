-- Foursome backend: recurring/standing availability
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations.
--
-- A fixed set of 6 tags (weekday/weekend x morning/afternoon/evening) rather
-- than free text or real time ranges — matches the feature as asked
-- ("weekday mornings", "weekend afternoons") and keeps it trivially
-- queryable/filterable later without parsing anything.
alter table users add column if not exists availability jsonb not null default '[]'::jsonb;
