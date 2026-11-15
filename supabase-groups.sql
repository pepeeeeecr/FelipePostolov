-- Groups: a name, a home course, a member list, a group chat, group rounds
-- and an optional weekly round. Run once in the Supabase SQL Editor. Until
-- it's run, the Groups section says groups aren't set up yet and
-- everything else keeps working as before.

create table if not exists groups (
  id text primary key,
  name text not null,
  home_course text not null,
  course_lat double precision,
  course_lng double precision,
  description text not null default '',
  creator_id text not null,
  invite_code text not null unique,
  -- Weekly round: posted automatically on weekly_day (0 = Sunday … 6 =
  -- Saturday) at weekly_time ("07:30"), with weekly_spots open spots.
  weekly_enabled boolean not null default false,
  weekly_day smallint,
  weekly_time text,
  weekly_spots smallint,
  weekly_last_date text,          -- date of the last weekly round posted
  created_at bigint not null,
  removed_at timestamptz           -- set when the creator deletes it or the owner removes it
);
create index if not exists idx_groups_creator on groups (creator_id);

-- status: 'member' or 'pending' (asked to join, waiting for the creator).
-- notify: this member's on/off switch for this group's notifications.
create table if not exists group_members (
  group_id text not null references groups (id) on delete cascade,
  user_id text not null,
  status text not null default 'member',
  notify boolean not null default true,
  created_at bigint not null,
  primary key (group_id, user_id)
);
create index if not exists idx_group_members_user on group_members (user_id);

create table if not exists group_messages (
  id bigint generated always as identity primary key,
  group_id text not null references groups (id) on delete cascade,
  sender_id text not null,
  sender_name text not null,
  text text not null,
  created_at bigint not null
);
create index if not exists idx_group_messages_group on group_messages (group_id, created_at);

-- A round posted to a group. open_to_all: leftover spots opened to everyone.
alter table teetimes add column if not exists group_id text;
alter table teetimes add column if not exists open_to_all boolean not null default false;
create index if not exists idx_teetimes_group on teetimes (group_id);

-- Reports about a group's name or description, or a group chat message.
alter table user_reports add column if not exists group_id text;
alter table user_reports add column if not exists group_message_id bigint;

-- Only the server (service role) reads and writes these.
alter table groups enable row level security;
alter table group_members enable row level security;
alter table group_messages enable row level security;
