-- Our own list of golf courses (Costa Rica first), plus a lasting cache for
-- course searches elsewhere. Run once in the Supabase SQL Editor.
--
-- golf_courses: every Costa Rica course, loaded from OpenStreetMap and
-- curated by hand (source = 'manual' rows are never overwritten by the
-- monthly OpenStreetMap refresh). Nearby searches inside Costa Rica are
-- answered from here: instant and complete.
-- To fix a course by hand in the Table Editor: edit name/lat/lng/town, set
-- source to 'manual' (so the refresh leaves it alone), or set active to
-- false to hide it.

create table if not exists golf_courses (
  id bigint generated always as identity primary key,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  town text,
  province text,
  country text not null default 'CR',
  holes integer,
  website text,
  osm_id text unique,                 -- e.g. 'way/123456'; null for manual-only rows
  source text not null default 'osm' check (source in ('osm', 'manual')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_golf_courses_country on golf_courses (country, active);
create unique index if not exists uniq_golf_courses_manual_name on golf_courses (lower(name)) where osm_id is null;

-- Course searches outside Costa Rica, kept so a server restart doesn't
-- throw them away (they used to live only in memory).
create table if not exists course_search_cache (
  key text primary key,               -- 'nearby:<lat>:<lng>' or 'search:<term>'
  data jsonb not null,
  complete boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table golf_courses enable row level security;
alter table course_search_cache enable row level security;
