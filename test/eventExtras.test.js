// Event extras: group prices and codes, the waitlist, refunding one guest,
// and refund webhooks that are about one guest vs. the whole payment.
const test = require('node:test');
const assert = require('node:assert');
const onvo = require('../onvo');
const { makeEventExtras, priceFor } = require('../eventExtras');
const { makePayments, remainingColones, guestShareColones } = require('../eventPayments');
const { localToInstant } = require('../events');
const { makeFakeSupabase } = require('./fakeSupabase');

const inDays = n => new Date(Date.now() + n * 24 * 3600e3).toISOString();

test('price: spots × price, codes, never below ₡500', () => {
  assert.deepStrictEqual(priceFor(25000, 3, null), { totalColones: 75000, discountColones: 0, dueColones: 75000 });
  assert.strictEqual(priceFor(25000, 2, { kind: 'percent', amount: 10 }).dueColones, 45000);
  assert.strictEqual(priceFor(25000, 1, { kind: 'fixed', amount: 5000 }).dueColones, 20000);
  assert.strictEqual(priceFor(25000, 1, { kind: 'percent', amount: 100 }).dueColones, 500, 'ONVO minimum');
  assert.strictEqual(priceFor(400, 1, { kind: 'fixed', amount: 100 }).dueColones, 400, 'never more than the total');
});

test('group share and what is left after guest refunds', () => {
  const reg = { amount_colones: 75001, guest_names: ['Beto', 'Carla'], guest_refunds: [{ amountColones: 25000, status: 'refunded' }, { amountColones: 25000, status: 'failed' }] };
  assert.strictEqual(guestShareColones(reg), 25000);
  assert.strictEqual(remainingColones(reg), 50001, 'a failed guest refund is not taken out');
});

function waitlistSetup(maxPlayers, regs) {
  const db = {
    events: [{ id: 1, title: 'Copa', status: 'open', starts_at: inDays(5), max_players: maxPlayers, price_colones: 25000 }],
    event_registrations: regs,
    event_waitlist: [],
    discount_codes: [],
  };
  const supabase = makeFakeSupabase(db);
  const pushes = [];
  const extras = makeEventExtras({
    supabase, isEventAdmin: () => true, localToInstant, getUser: async () => ({ name: 'X' }),
    notifyUser: async (userId, message) => { pushes.push({ userId, title: message('en')[0] }); },
  });
  return { db, extras, pushes };
}

test('waitlist: a freed spot is offered to the next person for 2 hours, then moves on', async () => {
  const { db, extras, pushes } = waitlistSetup(4, [
    { id: 1, event_id: 1, user_id: 'ana', status: 'confirmed', spots: 3 },
    { id: 2, event_id: 1, user_id: 'beto', status: 'confirmed', spots: 1 },
  ]);
  db.event_waitlist.push(
    { id: 10, event_id: 1, user_id: 'carla', status: 'waiting', created_at: inDays(-1) },
    { id: 11, event_id: 1, user_id: 'dani', status: 'waiting', created_at: inDays(-0.5) },
  );
  assert.strictEqual(await extras.processWaitlists(), 0, 'full: nobody offered');
  assert.strictEqual((await extras.myWaitlist(1, 'dani')).position, 2);

  db.event_registrations[1].status = 'refund_pending'; // Beto cancels
  assert.strictEqual(await extras.processWaitlists(), 1);
  assert.strictEqual(db.event_waitlist[0].status, 'offered');
  assert.strictEqual(db.event_waitlist[1].status, 'waiting', 'only one spot opened');
  assert.deepStrictEqual(pushes.map(p => p.userId), ['carla']);
  const hours = (new Date(db.event_waitlist[0].offered_until) - Date.now()) / 3600e3;
  assert.ok(hours > 1.9 && hours <= 2, '2 hours');

  // The kept spot counts as taken for everyone but Carla.
  const offers = (await extras.activeOffers([1])).get(1);
  assert.strictEqual(extras.takenSpots(db.event_registrations, offers, 'dani'), 4);
  assert.strictEqual(extras.takenSpots(db.event_registrations, offers, 'carla'), 3);

  // Carla doesn't pay in time: it goes to Dani.
  assert.strictEqual(await extras.processWaitlists(new Date(Date.now() + 2.1 * 3600e3)), 1);
  assert.strictEqual(db.event_waitlist[0].status, 'expired');
  assert.strictEqual(db.event_waitlist[1].status, 'offered');
});

test('refunding one guest, then the rest; webhooks settle the right thing', async () => {
  const db = {
    events: [{ id: 1, status: 'open', starts_at: inDays(5), cancel_cutoff_hours: 48, max_players: 10, price_colones: 25000 }],
    event_registrations: [{ id: 7, event_id: 1, user_id: 'ana', status: 'confirmed', spots: 3, guest_names: ['Beto', 'Carla'], guest_refunds: [],
      amount_colones: 75000, payment_intent_id: 'pi_1', refund_id: null }],
    onvo_webhook_events: [],
  };
  const supabase = makeFakeSupabase(db);
  const refunds = [];
  const original = onvo.createRefund;
  onvo.createRefund = async ({ amountColones }) => { refunds.push(amountColones); return { id: 'rf_' + refunds.length }; };
  try {
    const payments = makePayments({ supabase, ah: fn => fn });
    const reg = () => db.event_registrations[0];

    const out = await payments.refundGuest({ ...reg() }, 1);
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(refunds, [25000]);
    assert.strictEqual(reg().spots, 2, 'Carla’s spot is free');
    assert.strictEqual(reg().guest_refunds[0].refundId, 'rf_1');
    assert.strictEqual((await payments.refundGuest({ ...reg() }, 1)).status, 409, 'not twice');

    // ONVO: the guest refund went through. The payment stays confirmed.
    await payments._handleEvent({ type: 'refund.succeeded', data: { object: { id: 'rf_1', paymentIntentId: 'pi_1', amount: 2500000 } } });
    assert.strictEqual(reg().status, 'confirmed');
    assert.strictEqual(reg().guest_refunds[0].status, 'refunded');

    // Then the whole booking: only what's left.
    await payments.refundRegistration(7);
    assert.deepStrictEqual(refunds, [25000, 50000]);
    await payments._handleEvent({ type: 'refund.succeeded', data: { object: { id: 'rf_2', paymentIntentId: 'pi_1', amount: 5000000 } } });
    assert.strictEqual(reg().status, 'refunded');
  } finally {
    onvo.createRefund = original;
  }
});

test('a failed guest refund gives the spot back', async () => {
  const db = {
    event_registrations: [{ id: 8, event_id: 1, user_id: 'ana', status: 'confirmed', spots: 1, guest_names: ['Beto'],
      guest_refunds: [{ index: 0, name: 'Beto', amountColones: 25000, refundId: 'rf_9', status: 'pending' }], amount_colones: 50000, payment_intent_id: 'pi_2' }],
  };
  const payments = makePayments({ supabase: makeFakeSupabase(db), ah: fn => fn });
  await payments._handleEvent({ type: 'refund.failed', data: { object: { id: 'rf_9', paymentIntentId: 'pi_2', failureReason: 'bank said no' } } });
  assert.strictEqual(db.event_registrations[0].spots, 2);
  assert.strictEqual(db.event_registrations[0].status, 'confirmed', 'the payment itself is untouched');
  assert.strictEqual(db.event_registrations[0].guest_refunds[0].status, 'failed');
});
