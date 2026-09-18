-- Foursome backend: "Book a Tee Time" waitlist
-- Run this in Supabase Dashboard > SQL Editor > New query, alongside the
-- earlier migration files. Just collects demand signal (which courses
-- people ask for) — no real booking integration yet.

create table if not exists course_requests (
  id bigint generated always as identity primary key,
  course_name text not null,
  user_id text not null,
  created_at bigint not null
);

create index if not exists idx_course_requests_user_id on course_requests (user_id);
create index if not exists idx_course_requests_course_name on course_requests (course_name);
