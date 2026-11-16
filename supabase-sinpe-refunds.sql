-- Refunds for SINPE Móvil payments. ONVO can only refund card payments
-- through its API, so a SINPE Móvil payment that's cancelled is refunded by
-- hand: the spot is freed right away, the player confirms the number to
-- send it to, and the owner marks it as sent in Manage. Run once in the
-- Supabase SQL Editor, after supabase-event-extras.sql.

-- How the payment was made, from ONVO ('card', 'mobile_number', …); empty
-- when ONVO didn't say. A new status for a whole payment being refunded by
-- hand: 'refund_manual' (then 'refunded' once the owner sends it).
alter table event_registrations add column if not exists payment_method text;
alter table event_registrations drop constraint if exists event_registrations_status_check;
alter table event_registrations add constraint event_registrations_status_check
  check (status in ('held', 'confirmed', 'expired', 'failed', 'cancelled', 'refund_pending', 'refund_manual', 'refunded'));

-- Refunds to send by hand by SINPE Móvil. kind: 'payment' (the whole
-- payment, or what was left of it) or 'guest' (one guest of a group).
-- status: 'to_send' → 'sent'. phone: the number the player confirmed.
create table if not exists manual_refunds (
  id bigint generated always as identity primary key,
  registration_id bigint not null references event_registrations (id) on delete cascade,
  event_id bigint not null references events (id) on delete cascade,
  user_id text not null,
  user_name text not null default '',
  kind text not null check (kind in ('payment', 'guest')),
  guest_index int,
  guest_name text,
  amount_colones int not null check (amount_colones > 0),
  phone text,
  status text not null default 'to_send' check (status in ('to_send', 'sent')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_manual_refunds_status on manual_refunds (status, created_at);
create index if not exists idx_manual_refunds_user on manual_refunds (user_id, event_id);
alter table manual_refunds enable row level security;

-- The same two functions as supabase-event-extras.sql, with one change each:
-- a payment being refunded by hand counts as "already handled" (so a late
-- ONVO message can't confirm it again) and as a use of its discount code.
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
      where discount_code_id = dc.id and (status in ('confirmed', 'refund_pending', 'refund_manual', 'refunded') or (status = 'held' and hold_expires_at > now()));
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

  if reg.status in ('confirmed', 'refund_pending', 'refund_manual', 'refunded') then return 'already'; end if;

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


revoke all on function reserve_event_spots(bigint, text, text, int, int, text[], text) from public, anon, authenticated;
revoke all on function confirm_event_payment(bigint, text) from public, anon, authenticated;
