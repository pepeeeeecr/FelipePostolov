-- Notifications for new rounds and events, event follow-ups, evening-before
-- reminders, and "Did everyone show up?" after a round. Run once in the
-- Supabase SQL Editor. Until it's run, these features stay switched off and
-- everything else keeps working as before.

-- Every one of these notifications sent, so nobody gets the same one twice
-- and nobody gets more than 2 new-round/new-event notifications a day.
--   kind:   'new_round' | 'new_event' | 'event_3days' | 'event_spots'
--           | 'reminder_round' | 'reminder_event'
--   ref_id: the round id or event id it's about
create table if not exists notification_log (
  id bigint generated always as identity primary key,
  user_id text not null,
  kind text not null,
  ref_id text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, kind, ref_id)
);
create index if not exists idx_notification_log_user_sent on notification_log (user_id, sent_at desc);

-- After a round: each approved player (and the host) answers once.
-- no_show_ids is empty when everyone showed up.
create table if not exists round_attendance (
  id bigint generated always as identity primary key,
  teetime_id text not null,
  reporter_id text not null,
  no_show_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (teetime_id, reporter_id)
);
create index if not exists idx_round_attendance_teetime on round_attendance (teetime_id);

-- Only the server (service role) reads and writes these.
alter table notification_log enable row level security;
alter table round_attendance enable row level security;
