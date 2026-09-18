-- Foursome backend: "Book a Tee Time" — preferred date/time
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- the earlier supabase-course-requests.sql. Additive only — existing rows
-- just get null preferred_date/preferred_time.

alter table course_requests add column if not exists preferred_date text;
alter table course_requests add column if not exists preferred_time text;
