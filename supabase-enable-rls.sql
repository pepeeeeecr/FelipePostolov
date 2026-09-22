-- Foursome backend: enable Row Level Security on every public table
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations.
--
-- This server only ever talks to Supabase with the service_role key, which
-- bypasses RLS entirely — so nothing below changes how the backend behaves.
-- It's defense-in-depth for the hypothetical "anon/public key gets exposed
-- and someone queries these tables directly": with RLS on, that key alone
-- can only ever read/write a signed-in user's OWN data, never anyone
-- else's, and specifically can never read blocks or reports naming a user
-- who didn't create them (so a blocked/reported user can't discover it).
--
-- Guest accounts (the app's local-random-id identity, never a real
-- Supabase Auth session) have no auth.uid() at all, so every owner-scoped
-- policy below denies them by default under direct anon-key access — guest
-- data was never protected by anything stronger than obscurity to begin
-- with, and this doesn't change that; it only strengthens protection for
-- signed-in users, who now get a real cryptographic identity check.
--
-- One real limitation, noted rather than solved here: join-request writes
-- to teetimes.requests (a JSONB array a non-host user needs to append to)
-- can't be expressed as a simple row-ownership policy, so direct anon-key
-- UPDATE on teetimes is host-only below. Joining/withdrawing a request via
-- the anon key directly (bypassing this backend) isn't supported — exactly
-- as today, since nothing in this app ever does that; it only matters for
-- the "key got leaked" scenario this migration defends against.

alter table users enable row level security;
alter table teetimes enable row level security;
alter table ratings enable row level security;
alter table messages enable row level security;
alter table blocks enable row level security;
alter table course_requests enable row level security;
alter table push_subscriptions enable row level security;
alter table user_reports enable row level security;
alter table course_ratings enable row level security;

-- --- users (profiles) -------------------------------------------------------
-- Name/handicap/bio/availability are already shown to any other user in the
-- app (Discover cards, profile popovers) — SELECT is public on purpose, not
-- an oversight. Only the row's own owner can write it, and only via a real
-- Supabase Auth session (auth.uid()) — never via a client-supplied id.
drop policy if exists "users_select_public" on users;
create policy "users_select_public" on users for select using (true);

drop policy if exists "users_insert_own" on users;
create policy "users_insert_own" on users for insert to authenticated
  with check (auth.uid()::text = user_id);

drop policy if exists "users_update_own" on users;
create policy "users_update_own" on users for update to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

-- No DELETE policy: account deletion goes through the backend's
-- delete_user_account RPC for proper cascade (ratings, messages, teetimes,
-- blocks, etc.) — a bare row delete here would leave all of that orphaned.

-- --- teetimes (posted rounds) ------------------------------------------------
-- Rounds are meant to be publicly browsable (Discover) regardless of who's
-- asking — SELECT is public. Only the host can create/modify/cancel their
-- own round directly; see the note above about why join/withdraw isn't
-- expressible here the same way it is through the backend.
drop policy if exists "teetimes_select_public" on teetimes;
create policy "teetimes_select_public" on teetimes for select using (true);

drop policy if exists "teetimes_insert_own" on teetimes;
create policy "teetimes_insert_own" on teetimes for insert to authenticated
  with check (auth.uid()::text = host_id);

drop policy if exists "teetimes_update_own" on teetimes;
create policy "teetimes_update_own" on teetimes for update to authenticated
  using (auth.uid()::text = host_id)
  with check (auth.uid()::text = host_id);

drop policy if exists "teetimes_delete_own" on teetimes;
create policy "teetimes_delete_own" on teetimes for delete to authenticated
  using (auth.uid()::text = host_id);

-- --- ratings (player ratings) ------------------------------------------------
-- Average rating + count are shown on any profile, and full ratings
-- (rater/ratee/comment) are visible to anyone viewing that round already —
-- SELECT is public, matching what the app already exposes. Only the person
-- who gave a rating can create/change/retract it.
drop policy if exists "ratings_select_public" on ratings;
create policy "ratings_select_public" on ratings for select using (true);

drop policy if exists "ratings_insert_own" on ratings;
create policy "ratings_insert_own" on ratings for insert to authenticated
  with check (auth.uid()::text = rater_id);

drop policy if exists "ratings_update_own" on ratings;
create policy "ratings_update_own" on ratings for update to authenticated
  using (auth.uid()::text = rater_id)
  with check (auth.uid()::text = rater_id);

drop policy if exists "ratings_delete_own" on ratings;
create policy "ratings_delete_own" on ratings for delete to authenticated
  using (auth.uid()::text = rater_id);

-- --- messages (round chat) ---------------------------------------------------
-- The one table that genuinely needs a real "am I allowed in this room"
-- check rather than plain row ownership: only the host or an approved
-- participant of the round can read or post into its chat. A small
-- security-definer helper keeps the SELECT and INSERT policies identical
-- and readable instead of repeating the subquery twice.
create or replace function is_teetime_participant(p_teetime_id text, p_user_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
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

drop policy if exists "messages_select_participants" on messages;
create policy "messages_select_participants" on messages for select to authenticated
  using (is_teetime_participant(teetime_id, auth.uid()::text));

drop policy if exists "messages_insert_participants" on messages;
create policy "messages_insert_participants" on messages for insert to authenticated
  with check (sender_id = auth.uid()::text and is_teetime_participant(teetime_id, auth.uid()::text));

-- No UPDATE/DELETE: messages aren't editable or deletable anywhere in the
-- app today.

-- --- blocks -------------------------------------------------------------
-- The core safety requirement: a block is only ever visible to the person
-- who made it. blocked_id is deliberately never checked in any SELECT
-- policy — a blocked user must never be able to query and discover they've
-- been blocked.
drop policy if exists "blocks_select_own" on blocks;
create policy "blocks_select_own" on blocks for select to authenticated
  using (auth.uid()::text = blocker_id);

drop policy if exists "blocks_insert_own" on blocks;
create policy "blocks_insert_own" on blocks for insert to authenticated
  with check (auth.uid()::text = blocker_id);

drop policy if exists "blocks_update_own" on blocks;
create policy "blocks_update_own" on blocks for update to authenticated
  using (auth.uid()::text = blocker_id)
  with check (auth.uid()::text = blocker_id);

drop policy if exists "blocks_delete_own" on blocks;
create policy "blocks_delete_own" on blocks for delete to authenticated
  using (auth.uid()::text = blocker_id);

-- --- course_requests (Book a Tee Time waitlist) ------------------------------
-- Purely personal — nobody else has any reason to see or touch your
-- waitlist entries.
drop policy if exists "course_requests_select_own" on course_requests;
create policy "course_requests_select_own" on course_requests for select to authenticated
  using (auth.uid()::text = user_id);

drop policy if exists "course_requests_insert_own" on course_requests;
create policy "course_requests_insert_own" on course_requests for insert to authenticated
  with check (auth.uid()::text = user_id);

drop policy if exists "course_requests_delete_own" on course_requests;
create policy "course_requests_delete_own" on course_requests for delete to authenticated
  using (auth.uid()::text = user_id);

-- --- push_subscriptions -------------------------------------------------------
-- Contains push endpoints/tokens — private by nature, scoped entirely to
-- the owning user.
drop policy if exists "push_subscriptions_select_own" on push_subscriptions;
create policy "push_subscriptions_select_own" on push_subscriptions for select to authenticated
  using (auth.uid()::text = user_id);

drop policy if exists "push_subscriptions_insert_own" on push_subscriptions;
create policy "push_subscriptions_insert_own" on push_subscriptions for insert to authenticated
  with check (auth.uid()::text = user_id);

drop policy if exists "push_subscriptions_update_own" on push_subscriptions;
create policy "push_subscriptions_update_own" on push_subscriptions for update to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

drop policy if exists "push_subscriptions_delete_own" on push_subscriptions;
create policy "push_subscriptions_delete_own" on push_subscriptions for delete to authenticated
  using (auth.uid()::text = user_id);

-- --- user_reports -------------------------------------------------------------
-- The other core safety requirement: a report is only ever visible to the
-- person who filed it. reported_id is deliberately never checked in any
-- SELECT policy — the person a report is about must never be able to read
-- it. No UPDATE/DELETE at all: not even the reporter can alter or erase a
-- report once filed (matches delete_user_account's own behavior — reports
-- filed against a user outlive that user's account on purpose).
drop policy if exists "user_reports_select_own" on user_reports;
create policy "user_reports_select_own" on user_reports for select to authenticated
  using (auth.uid()::text = reporter_id);

drop policy if exists "user_reports_insert_own" on user_reports;
create policy "user_reports_insert_own" on user_reports for insert to authenticated
  with check (auth.uid()::text = reporter_id);

-- --- course_ratings (course reviews) ------------------------------------------
-- Average course rating + individual reviews are shown to anyone browsing
-- or searching courses — SELECT is public, matching what the app already
-- exposes. Only the reviewer can create/edit/retract their own review.
drop policy if exists "course_ratings_select_public" on course_ratings;
create policy "course_ratings_select_public" on course_ratings for select using (true);

drop policy if exists "course_ratings_insert_own" on course_ratings;
create policy "course_ratings_insert_own" on course_ratings for insert to authenticated
  with check (auth.uid()::text = rater_id);

drop policy if exists "course_ratings_update_own" on course_ratings;
create policy "course_ratings_update_own" on course_ratings for update to authenticated
  using (auth.uid()::text = rater_id)
  with check (auth.uid()::text = rater_id);

drop policy if exists "course_ratings_delete_own" on course_ratings;
create policy "course_ratings_delete_own" on course_ratings for delete to authenticated
  using (auth.uid()::text = rater_id);
