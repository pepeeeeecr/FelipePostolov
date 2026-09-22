-- Foursome backend: course ratings/reviews
-- Run this in Supabase Dashboard > SQL Editor > New query, in addition to
-- earlier migrations.
--
-- Courses have no canonical id anywhere in this app (teetimes.course,
-- course_requests.course_name, and the OpenStreetMap search results all key
-- a course by its plain name string — the search results already dedupe by
-- name for the same reason). course_ratings follows that same convention
-- rather than introducing a new courses table just for this.
--
-- One rating per (course, rater) — an editable review, like a Google/Yelp
-- review, not one entry per round played there. Upserted in server.js the
-- same way player ratings are (delete then insert), enforced here too via
-- the unique constraint so a duplicate can never land even under a race.
create table if not exists course_ratings (
  id bigint generated always as identity primary key,
  course_name text not null,
  rater_id text not null,
  rater_name text not null,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at bigint not null,
  unique (course_name, rater_id)
);

create index if not exists idx_course_ratings_course_name on course_ratings (course_name);

-- RLS left disabled, same as every other table — only the service_role key
-- ever talks to Supabase directly.
