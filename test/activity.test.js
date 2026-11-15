// The Discover activity line: within 100 km, counts below 5 hidden.
const test = require('node:test');
const assert = require('node:assert');
const { registerActivity } = require('../activity');
const { makeFakeSupabase } = require('./fakeSupabase');

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const HOMES = { cariari: { lat: 9.97, lng: -84.16 }, pinilla: { lat: 10.26, lng: -85.84 } };
const day = n => new Date(Date.now() + n * 24 * 3600e3).toISOString().slice(0, 10);

function run(users, rounds, events) {
  const supabase = makeFakeSupabase({ users, teetimes: rounds, events });
  const routes = {};
  registerActivity({ get: (p, h) => (routes[p] = h) }, {
    supabase, ah: f => f, verifiedUserId: () => 'me', haversineMiles, peekHome: n => HOMES[n.toLowerCase()] || null,
    DEMO_USER_IDS: new Set(), whenLabel: () => 'Sat 8:00 AM',
  });
  return async q => { let out; await routes['/api/activity']({ query: q, lang: 'en' }, { json: b => (out = b) }); return out; };
}

test('counts within 100 km, hides anything under 5', async () => {
  const users = [{ user_id: 'me', home_course: 'Cariari' },
    ...Array.from({ length: 6 }, (_, i) => ({ user_id: 'c' + i, home_course: 'Cariari' })),
    ...Array.from({ length: 9 }, (_, i) => ({ user_id: 'p' + i, home_course: 'Pinilla' }))];   // ~190 km away
  const rounds = [1, 2, 3].map(i => ({ id: 'r' + i, host_id: 'c1', course: 'Cariari', date: day(i), open_spots: 2, status: 'active' }));
  const events = [{ id: 1, title: 'Copa', course: 'Cariari', lat: 9.97, lng: -84.16, starts_at: new Date(Date.now() + 3 * 864e5).toISOString(), status: 'open' }];
  const get = run(users, rounds, events);
  const a = await get({ lat: '9.93', lng: '-84.08' });
  assert.strictEqual(a.golfers, 6, 'me and far-away golfers not counted');
  assert.strictEqual(a.openRoundsThisWeek, null, '3 rounds: hidden');
  assert.deepStrictEqual(a.nextEvent, { id: 1, title: 'Copa', course: 'Cariari', whenLabel: 'Sat 8:00 AM' });

  // From the home course when the phone sends no location; far from everything: all hidden.
  const b = await run(users, rounds, [])({ lat: '40.27', lng: '-74.78' });
  assert.deepStrictEqual(b, { golfers: null, openRoundsThisWeek: null, nextEvent: null });
  const c = await run(users, rounds, [])({});
  assert.strictEqual(c.golfers, 6, 'uses my home course');
});
