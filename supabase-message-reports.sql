-- Per-message reports in round chat. Run once in the Supabase SQL Editor.
--
-- A report can now point at one chat message. The message text is copied
-- into the report so it survives if the round (and its chat) is deleted.
-- Until this runs, the server still saves message reports, with the
-- message folded into the reason column instead.
alter table user_reports add column if not exists message_id bigint;
alter table user_reports add column if not exists teetime_id text;
alter table user_reports add column if not exists message_text text;

create index if not exists idx_user_reports_message_id on user_reports (message_id);
