-- Event extras: paying for a group (2–4 spots with guests' names), refunds
-- for one guest, discount codes, a waitlist when an event is full, and
-- results and photos after an event. Run once in the Supabase SQL Editor,
-- after supabase-event-payments.sql. Until it's run, events work exactly
-- as before (one spot per payment, no codes, no waitlist).

-- --- Paying for a group ----------------------------------------------------------
-- spots: how many spots this payment covers right now (1–4). It goes down
-- by one when a guest is refunded. guest_names: the guests the buyer named
-- (spots - 1 of them at purchase). guest_refunds: one entry per refunded
-- guest: { "name", "amountColones", "refundId", "status" }.
alter table event_registrations add column if not exists spots smallint not null default 1;
alter table event_registrations add column if not exists guest_names text[] not null default '{}';
alter table event_registrations add column if not exists guest_refunds jsonb not null default '[]';
alter table event_registrations drop constraint if exists event_registrations_spots_check;
alter table event_registrations add constraint event_registrations_spots_check check (spots between 0 and 4);

-- --- Discount codes ------------------------------------------------------------
-- kind 'percent' (amount = 1–100) or 'fixed' (amount = colones off the
-- whole payment). event_id empty = any event. A code is used once per
-- payment; held-but-unpaid payments count while the hold lasts.
create table if not exists discount_codes (
  id bigint generated always as identity primary key,
  code text not null unique,
  kind text not null check (kind in ('percent', 'fixed')),
  amount int not null check (amount > 0),
  max_uses int not null check (max_uses between 1 and 10000),
  expires_at timestamptz not null,
  event_id bigint references events (id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table event_registrations add column if not exists discount_code_id bigint references discount_codes (id) on delete set null;
alter table event_registrations add column if not exists discount_colones int not null default 0;

-- --- Waitlist ------------------------------------------------------------------
-- status: waiting → offered (a spot is kept for them until offered_until,
-- 2 hours) → claimed (they paid) or expired (it moved on). Or left.
create table if not exists event_waitlist (
  id bigint generated always as identity primary key,
  event_id bigint not null references events (id) on delete cascade,
  user_id text not null,
  user_name text not null default '',
  status text not null default 'waiting',
  offered_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_event_waitlist_active on event_waitlist (event_id, user_id) where status in ('waiting', 'offered');
create index if not exists idx_event_waitlist_event on event_waitlist (event_id, status, created_at);

-- --- Results and photos after an event ---------------------------------------
alter table events add column if not exists results_text text;
alter table events add column if not exists results_photos jsonb not null default '[]';
alter table events add column if not exists results_posted_at timestamptz;

alter table discount_codes enable row level security;
alter table event_waitlist enable row level security;

-- --- Counting spots ------------------------------------------------------------
-- Spots taken in an event: paid spots, unexpired holds, and spots kept for
-- someone on the waitlist (unless they already hold or paid, which is
-- counted already). p_except_user's own offer isn't counted, so it can be used.
create or replace function event_spots_taken(p_event_id bigint, p_except_user text)
returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(spots) from event_registrations
      where event_id = p_event_id and (status = 'confirmed' or (status = 'held' and hold_expires_at > now()))), 0)::int
    + (select count(*) from event_waitlist w
      where w.event_id = p_event_id and w.status = 'offered' and w.offered_until > now()
        and w.user_id is distinct from p_except_user
        and not exists (select 1 from event_registrations r where r.event_id = w.event_id and r.user_id = w.user_id
          and (r.status = 'confirmed' or (r.status = 'held' and r.hold_expires_at > now()))))::int;
$$;

-- --- Holding spots (replaces reserve_event_spot for the app) -------------------
-- Like reserve_event_spot, plus: several spots with guests' names, and a
-- discount code. Locks the event (and the code), so two people can't take
-- the last spot or the last use of a code. Returns the registration and one
-- of: held, confirmed, refund_pending, full, not_enough, bad_code,
-- code_used_up, closed, not_found.
create or replace function reserve_event_spots(
  p_event_id bigint, p_user_id text, p_user_name text, p_hold_minutes int,
  p_spots int, p_guest_names text[], p_code text)
returns table (registration_id bigint, result text)
language plpgsql security definer set search_path = public as $$
declare
  ev events;
  mine event_registrations;
  dc discount_codes;
  taken int;
  used int;
  total int;
  off int := 0;
  due int;
  new_id bigint;
begin
  if p_spots is null or p_spots < 1 or p_spots > 4 then return query select null::bigint, 'not_enough'::text; return; end if;
  select * into ev from events where id = p_event_id for update;
  if not found then return query select null::bigint, 'not_found'::text; return; end if;
  if ev.status <> 'open' or ev.starts_at <= now() then return query select null::bigint, 'closed'::text; return; end if;

  select * into mine from event_registrations
    where event_id = p_event_id and user_id = p_user_id and status in ('held', 'confirmed', 'refund_pending')
    order by id desc limit 1;
  if found then
    if mine.status = 'held' and mine.hold_expires_at > now() then
      return query select mine.id, 'held'::text; return;
    elsif mine.status <> 'held' then
      return query select mine.id, mine.status; return;
    end if;
    update event_registrations set status = 'expired', updated_at = now() where id = mine.id;
  end if;

  taken := event_spots_taken(p_event_id, p_user_id);
  if taken >= ev.max_players then return query select null::bigint, 'full'::text; return; end if;
  if taken + p_spots > ev.max_players then return query select null::bigint, 'not_enough'::text; return; end if;

  total := ev.price_colones * p_spots;
  if p_code is not null and btrim(p_code) <> '' then
    select * into dc from discount_codes where upper(code) = upper(btrim(p_code)) for update;
    if not found or not dc.active or dc.expires_at <= now() or (dc.event_id is not null and dc.event_id <> p_event_id) then
      return query select null::bigint, 'bad_code'::text; return;
    end if;
    select count(*) into used from event_registrations
      where discount_code_id = dc.id and (status in ('confirmed', 'refund_pending', 'refunded') or (status = 'held' and hold_expires_at > now()));
    if used >= dc.max_uses then return query select null::bigint, 'code_used_up'::text; return; end if;
    off := case when dc.kind = 'percent' then round(total * least(dc.amount, 100) / 100.0)::int else dc.amount end;
  end if;
  -- ONVO can't take less than ₡500, so a discount stops there.
  due := greatest(total - off, least(total, 500));

  insert into event_registrations (event_id, user_id, user_name, status, hold_expires_at, amount_colones, spots, guest_names, discount_code_id, discount_colones)
    values (p_event_id, p_user_id, p_user_name, 'held', now() + make_interval(mins => p_hold_minutes), due,
            p_spots, coalesce(p_guest_names, '{}'), case when off > 0 then dc.id else null end, total - due)
    returning id into new_id;
  return query select new_id, 'held'::text;
end $$;

-- Same as before, but counts spots (and waitlist offers), and marks the
-- buyer's waitlist place as claimed once they've paid.
create or replace function confirm_event_payment(p_registration_id bigint, p_payment_intent_id text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  reg event_registrations;
  ev events;
  taken int;
begin
  select * into reg from event_registrations where id = p_registration_id;
  if not found then return 'not_found'; end if;
  select * into ev from events where id = reg.event_id for update;
  select * into reg from event_registrations where id = p_registration_id for update;

  if reg.status in ('confirmed', 'refund_pending', 'refunded') then return 'already'; end if;

  if ev.status = 'open' and reg.status = 'held' and reg.hold_expires_at > now() then
    update event_registrations set status = 'confirmed', paid_at = now(), payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id), updated_at = now() where id = reg.id;
    update event_waitlist set status = 'claimed', updated_at = now() where event_id = reg.event_id and user_id = reg.user_id and status in ('waiting', 'offered');
    return 'confirmed';
  end if;

  -- The hold ran out before ONVO confirmed: still fine if there's room.
  taken := event_spots_taken(reg.event_id, reg.user_id)
    - (case when reg.status = 'held' and reg.hold_expires_at > now() then reg.spots else 0 end);
  if ev.status = 'open' and ev.starts_at > now() and taken + reg.spots <= ev.max_players then
    update event_registrations set status = 'confirmed', paid_at = now(), payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id), updated_at = now() where id = reg.id;
    update event_waitlist set status = 'claimed', updated_at = now() where event_id = reg.event_id and user_id = reg.user_id and status in ('waiting', 'offered');
    return 'confirmed';
  end if;

  update event_registrations set status = 'refund_pending', paid_at = now(), payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id), updated_at = now() where id = reg.id;
  return 'needs_refund';
end $$;

revoke all on function event_spots_taken(bigint, text) from public, anon, authenticated;
revoke all on function reserve_event_spots(bigint, text, text, int, int, text[], text) from public, anon, authenticated;
revoke all on function confirm_event_payment(bigint, text) from public, anon, authenticated;
