-- Partner courses: courses the owner marks in Manage. Each gets a public web
-- page (/c/<slug>) with its upcoming rounds and events, and a printable QR
-- poster (/c/<slug>/poster). Run once in the Supabase SQL Editor. Until
-- it's run, Manage says partner courses aren't set up yet.

create table if not exists partner_courses (
  id bigint generated always as identity primary key,
  slug text not null unique,          -- the page address, e.g. 'valle-del-sol'
  name text not null,
  lat double precision,
  lng double precision,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Only the server (service role) reads and writes it.
alter table partner_courses enable row level security;
