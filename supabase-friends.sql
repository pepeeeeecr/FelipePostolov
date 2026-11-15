-- Friends, and inviting friends to a round. Run once in the Supabase SQL
-- Editor. Until it's run, the Friends page says friends aren't set up yet
-- and everything else keeps working as before.

-- One row per pair of people. user_a/user_b are the two ids in sorted
-- order, so a pair can only have one row. status: 'pending' (requester_id
-- asked, waiting for the other person) or 'accepted'.
create table if not exists friendships (
  id bigint generated always as identity primary key,
  user_a text not null,
  user_b text not null,
  requester_id text not null,
  status text not null default 'pending',
  created_at bigint not null,
  unique (user_a, user_b)
);
create index if not exists idx_friendships_a on friendships (user_a);
create index if not exists idx_friendships_b on friendships (user_b);

-- Friends invited to a round when it was posted: they can see and join it
-- even if it's a members-only group round.
alter table teetimes add column if not exists invited_ids text[] not null default '{}';

-- Only the server (service role) reads and writes these.
alter table friendships enable row level security;
