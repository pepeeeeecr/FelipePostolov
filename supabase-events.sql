-- Paid events (parts F and B). Run once in the Supabase SQL Editor.
--
-- events: created by the owner from the in-app admin screen, or by hand in
-- the Supabase Table Editor as a backup (see the column notes below).
-- event_registrations: one row per person per event; payment fills these in
-- (a later part). event_requests: "Request an event" from regular users.

create table if not exists events (
  id bigint generated always as identity primary key,
  -- Fill these in when adding an event by hand in the Table Editor:
  title text not null,                                   -- e.g. 'Saturday Scramble'
  course text not null,                                  -- course name, e.g. 'Bethpage Black Golf Course'
  starts_at timestamptz not null,                        -- e.g. '2026-11-22 08:00:00-05' (include the UTC offset)
  time_zone text not null default 'America/New_York',    -- where the course is, e.g. 'America/Chicago'
  price_cents integer not null check (price_cents >= 50),-- renamed to price_colones by supabase-event-payments.sql
  max_players integer not null check (max_players between 1 and 500),
  -- Optional (defaults are fine):
  description text not null default '',
  cancel_cutoff_hours integer not null default 48 check (cancel_cutoff_hours between 0 and 720),
  lat double precision,                                  -- left empty, the server looks the course up
  lng double precision,
  currency text not null default 'usd' check (currency = 'usd'),
  status text not null default 'open' check (status in ('open', 'cancelled')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_events_starts_at on events (starts_at);

create table if not exists event_registrations (
  id bigint generated always as identity primary key,
  event_id bigint not null references events (id),
  user_id text not null,
  user_name text not null,
  -- held: spot reserved while paying; confirmed: ONVO confirmed payment;
  -- expired/failed: hold released; cancelled/refund_pending/refunded: undone.
  status text not null check (status in ('held', 'confirmed', 'expired', 'failed', 'cancelled', 'refund_pending', 'refunded')),
  hold_expires_at timestamptz,
  payment_intent_id text unique,
  amount_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_event_registrations_event on event_registrations (event_id, status);
create index if not exists idx_event_registrations_user on event_registrations (user_id);
-- One live registration per person per event.
create unique index if not exists uniq_event_registrations_active
  on event_registrations (event_id, user_id)
  where status in ('held', 'confirmed', 'refund_pending');

create table if not exists event_requests (
  id bigint generated always as identity primary key,
  user_id text not null,
  user_name text not null default '',
  course text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_event_requests_created on event_requests (created_at desc);

-- Same as every other table: RLS on, no policies, so only the server
-- (service_role key) can read or write these.
alter table events enable row level security;
alter table event_registrations enable row level security;
alter table event_requests enable row level security;
