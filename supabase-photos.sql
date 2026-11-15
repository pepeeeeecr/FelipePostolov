-- Profile photos. Run once in the Supabase SQL Editor (and create the
-- "profile-photos" storage bucket — see the setup steps). Until it's run,
-- photos stay off and everything else works as before.

-- The public address of each person's current photo (null = no photo).
alter table users add column if not exists photo_url text;

-- A report about someone's photo keeps the address of the photo reported.
alter table user_reports add column if not exists photo_url text;
