-- Foursome backend: Supabase schema
-- Run this in Supabase Dashboard > SQL Editor > New query.
-- Mirrors the old better-sqlite3 schema, with two changes:
--   * requests / viewed_by / subscription are JSONB (were JSON-in-TEXT)
--   * is_pro / host_is_pro are native BOOLEAN (were 0/1 INTEGER)
-- created_at / updated_at stay as BIGINT epoch-ms to match Date.now()
-- in the app code exactly (no app-level date parsing needed).

create table if not exists users (
  user_id text primary key,
  name text not null,
  home_course text,
  handicap double precision,
  is_pro boolean not null default false,
  stripe_customer_id text,
  bio text default '',
  updated_at bigint not null
);

create table if not exists teetimes (
  id text primary key,
  host_id text not null,
  host_name text not null,
  host_is_pro boolean not null default false,
  host_handicap double precision,
  course text not null,
  lat double precision,
  lng double precision,
  date text not null,
  time text not null,
  total_spots integer not null,
  open_spots integer not null,
  hcp_range text,
  pace text,
  notes text,
  status text not null default 'active',
  requests jsonb not null default '[]'::jsonb,
  viewed_by jsonb not null default '[]'::jsonb,
  created_at bigint not null
);

create table if not exists ratings (
  id bigint generated always as identity primary key,
  teetime_id text not null,
  rater_id text not null,
  ratee_id text not null,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at bigint not null
);

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id text not null,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at bigint not null
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  teetime_id text not null,
  sender_id text not null,
  sender_name text not null,
  text text not null,
  created_at bigint not null
);

-- Indexes matching the app's actual query patterns
create index if not exists idx_teetimes_host_id on teetimes (host_id);
create index if not exists idx_teetimes_created_at on teetimes (created_at desc);
create index if not exists idx_ratings_ratee_id on ratings (ratee_id);
create index if not exists idx_ratings_teetime_id on ratings (teetime_id);
create index if not exists idx_push_subscriptions_user_id on push_subscriptions (user_id);
create index if not exists idx_messages_teetime_id on messages (teetime_id, created_at);

-- RLS is left disabled: the server only ever connects with the
-- service_role key, which bypasses RLS anyway. Do not expose these
-- tables to the anon/public key without adding RLS policies first.
