-- Paid events, parts C and D: colones (CRC) pricing and ONVO payments.
-- Run once in the Supabase SQL Editor, after supabase-events.sql.

-- --- Prices in whole colones -------------------------------------------------
-- price_colones is whole colones: ₡25,000 is 25000. ONVO is sent céntimos
-- (×100). Renamed from price_cents (USD) — fine while no events are paid.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'events' and column_name = 'price_cents') then
    alter table events rename column price_cents to price_colones;
  end if;
end $$;
alter table events drop constraint if exists events_price_cents_check;
alter table events drop constraint if exists events_price_colones_check;
alter table events add constraint events_price_colones_check check (price_colones between 500 and 2000000);

alter table events drop constraint if exists events_currency_check;
alter table events alter column currency set default 'crc';
update events set currency = 'crc' where currency <> 'crc';
alter table events add constraint events_currency_check check (currency = 'crc');

-- --- Registrations: ONVO references -------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'event_registrations' and column_name = 'amount_cents') then
    alter table event_registrations rename column amount_cents to amount_colones;
  end if;
end $$;
alter table event_registrations add column if not exists checkout_session_id text unique;
alter table event_registrations add column if not exists checkout_url text;
alter table event_registrations add column if not exists paid_at timestamptz;
alter table event_registrations add column if not exists refund_id text;
alter table event_registrations add column if not exists refund_error text;
alter table event_registrations add column if not exists refunded_at timestamptz;

-- Webhook events already handled, so a re-delivered event is ignored.
create table if not exists onvo_webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table onvo_webhook_events enable row level security;

-- --- Holding a spot ------------------------------------------------------------
-- Locks the event row, so two people asking for the last spot at the same
-- moment are handled one after the other: only one gets it. Returns the
-- registration and one of: held, confirmed, refund_pending (already has
-- one), full, closed, not_found.
create or replace function reserve_event_spot(p_event_id bigint, p_user_id text, p_user_name text, p_hold_minutes int)
returns table (registration_id bigint, result text)
language plpgsql security definer set search_path = public as $$
declare
  ev events;
  mine event_registrations;
  taken int;
  new_id bigint;
begin
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
    -- Their own hold ran out: let it go and try again below.
    update event_registrations set status = 'expired', updated_at = now() where id = mine.id;
  end if;

  select count(*) into taken from event_registrations
    where event_id = p_event_id
      and (status = 'confirmed' or (status = 'held' and hold_expires_at > now()));
  if taken >= ev.max_players then return query select null::bigint, 'full'::text; return; end if;

  insert into event_registrations (event_id, user_id, user_name, status, hold_expires_at, amount_colones)
    values (p_event_id, p_user_id, p_user_name, 'held', now() + make_interval(mins => p_hold_minutes), ev.price_colones)
    returning id into new_id;
  return query select new_id, 'held'::text;
end $$;

-- Called only from the ONVO webhook, once ONVO says the payment succeeded.
-- Confirms the spot if the hold is still good, or if it ran out but there's
-- still room. Otherwise (event full or cancelled) marks it for a refund.
-- Returns: confirmed, already, needs_refund, not_found.
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
    return 'confirmed';
  end if;

  select count(*) into taken from event_registrations
    where event_id = reg.event_id and id <> reg.id
      and (status = 'confirmed' or (status = 'held' and hold_expires_at > now()));
  if ev.status = 'open' and ev.starts_at > now() and taken < ev.max_players then
    update event_registrations set status = 'confirmed', paid_at = now(), payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id), updated_at = now() where id = reg.id;
    return 'confirmed';
  end if;

  update event_registrations set status = 'refund_pending', paid_at = now(), payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id), updated_at = now() where id = reg.id;
  return 'needs_refund';
end $$;

revoke all on function reserve_event_spot(bigint, text, text, int) from public, anon, authenticated;
revoke all on function confirm_event_payment(bigint, text) from public, anon, authenticated;
