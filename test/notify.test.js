// Round and event notifications: who gets them, the 2-per-day cap, the
// Settings switches, never the creator, never twice, and the text.
const test = require('node:test');
const assert = require('node:assert');
const { makeNotifier } = require('../notify');
const { makeFakeSupabase } = require('./fakeSupabase');

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const COURSES = {
  'club campestre cariari': { lat: 9.971757, lng: -84.157537 },
  'valle del sol (santa ana)': { lat: 9.948599, lng: -84.212417 },   // ~6 km from Cariari
  'hacienda pinilla': { lat: 10.256543, lng: -85.841804 },          // ~187 km
  'trenton country club': { lat: 40.244831, lng: -74.8140825 },
};
const geocodeCourse = async name => COURSES[name.toLowerCase()] || null;
const sub = (prefs, lang = 'es') => ({ token: 'x', lang, ...(prefs ? { prefs } : {}) });

function setup() {
  const db = {
    users: [
      { user_id: 'host', home_course: 'Club Campestre Cariari' },
      { user_id: 'ana', home_course: 'Club Campestre Cariari' },          // same course
      { user_id: 'beto', home_course: 'Valle del Sol (Santa Ana)' },     // 6 km
      { user_id: 'caro', home_course: 'Hacienda Pinilla' },              // too far
      { user_id: 'dani', home_course: 'Club Campestre Cariari' },        // switched rounds off
      { user_id: 'eva', home_course: 'Club Campestre Cariari', banned: true },
      { user_id: 'fede', home_course: 'Club Campestre Cariari' },        // blocked the host
      { user_id: 'gabi', home_course: 'Valle del Sol (Santa Ana)' },     // miles, English
    ],
    push_subscriptions: [
      { user_id: 'host', subscription: sub() }, { user_id: 'ana', subscription: sub() },
      { user_id: 'beto', subscription: sub({ rounds: true, events: true, unit: 'km' }) },
      { user_id: 'caro', subscription: sub() }, { user_id: 'dani', subscription: sub({ rounds: false, events: true, unit: 'km' }) },
      { user_id: 'eva', subscription: sub() }, { user_id: 'fede', subscription: sub() },
      { user_id: 'gabi', subscription: sub({ rounds: true, events: true, unit: 'mi' }, 'en') },
    ],
    blocks: [{ blocker_id: 'fede', blocked_id: 'host' }],
    notification_log: [], course_search_cache: [], event_registrations: [], events: [], teetimes: [],
  };
  const supabase = makeFakeSupabase(db, { unique: { notification_log: ['user_id', 'kind', 'ref_id'] } });
  const sent = [];
  async function notifyUser(userId, message, _body, opts = {}) {
    for (const row of db.push_subscriptions.filter(r => r.user_id === userId)) {
      if (opts.accept && !opts.accept(row.subscription)) continue;
      const [title, body] = message(row.subscription.lang, row.subscription);
      sent.push({ userId, title, body, url: opts.data && opts.data.url });
    }
  }
  const n = makeNotifier({ supabase, notifyUser, geocodeCourse, haversineMiles, DEMO_USER_IDS: new Set() });
  return { db, n, sent };
}

const inDays = d => new Date(Date.now() + d * 24 * 3600e3).toISOString();

test('new round: people whose home course is that course, minus host, banned, blocked and switched off', async () => {
  const { n, sent } = setup();
  await n.newRound({ id: 'tt_1', host_id: 'host', course: 'Club Campestre Cariari', lat: 9.971757, lng: -84.157537, date: '2026-11-20', time: '08:00', open_spots: 3 });
  assert.deepStrictEqual(sent.map(s => s.userId).sort(), ['ana']);
  assert.strictEqual(sent[0].title, 'Ronda nueva en Club Campestre Cariari');
  assert.ok(sent[0].url.endsWith('/r/tt_1'));
});

test('new event: within 100 km by home course, distance in each person’s unit, never the creator', async () => {
  const { n, sent } = setup();
  const ev = { id: 7, created_by: 'host', title: 'Scramble', course: 'Cariari', lat: 9.971757, lng: -84.157537,
    starts_at: inDays(2), time_zone: 'America/Costa_Rica', price_colones: 25000, status: 'open', max_players: 20 };
  await n.newEvent(ev);
  const who = sent.map(s => s.userId).sort();
  assert.deepStrictEqual(who, ['ana', 'beto', 'dani', 'gabi']);
  // Ana's home course is the event's course (same spot): no distance shown.
  assert.match(sent.find(s => s.userId === 'ana').body, /^Evento nuevo en Cariari: .+, ₡25,000$/);
  const beto = sent.find(s => s.userId === 'beto').body;
  assert.match(beto, /^Evento nuevo en Cariari, a 6\.\d km: [A-ZÁÉÍÓÚ][a-záéíóú]+ \d{1,2}:\d{2}.*, ₡25,000$/);
  assert.match(sent.find(s => s.userId === 'gabi').body, /^New event at Cariari, 4\.\d mi away: .+, ₡25,000$/);
});

test('2 per day cap, nothing twice, and event follow-ups skip people who joined', async () => {
  const { db, n, sent } = setup();
  for (const id of ['tt_a', 'tt_b', 'tt_c']) {
    await n.newRound({ id, host_id: 'host', course: 'Club Campestre Cariari', lat: null, lng: null, date: '2026-11-20', time: '08:00', open_spots: 2 });
  }
  await n.newRound({ id: 'tt_a', host_id: 'host', course: 'Club Campestre Cariari', date: '2026-11-20', time: '08:00', open_spots: 2 });
  assert.strictEqual(sent.filter(s => s.userId === 'ana').length, 2, 'ana capped at 2');

  sent.length = 0;
  const ev = { id: 8, created_by: 'host', title: 'Copa', course: 'Valle del Sol (Santa Ana)', lat: 9.948599, lng: -84.212417,
    starts_at: inDays(2.5), time_zone: 'America/Costa_Rica', price_colones: 30000, status: 'open', max_players: 4 };
  db.events.push(ev);
  db.event_registrations.push({ event_id: 8, user_id: 'beto', status: 'confirmed' });
  await n.tick();
  const kinds = db.notification_log.filter(l => l.ref_id === '8').map(l => `${l.user_id}:${l.kind}`).sort();
  assert.ok(!kinds.some(k => k.startsWith('beto:')), 'beto joined: no follow-ups');
  assert.ok(!kinds.some(k => k.startsWith('host:')), 'creator: none');
  assert.ok(kinds.includes('gabi:event_3days'), JSON.stringify(kinds));
  assert.ok(kinds.includes('dani:event_3days'));
  // gabi is under the cap: the "3 spots left" one also goes (dani too)
  assert.ok(kinds.includes('gabi:event_spots'));
  const before = sent.length;
  await n.tick();
  assert.strictEqual(sent.length, before, 'nothing sent twice');
});

test('evening-before reminder for an event, in its time zone', async () => {
  const { db, n, sent } = setup();
  const { localParts, nextDay } = n._internals;
  const here = localParts('America/Costa_Rica');
  // An event tomorrow at 08:00 Costa Rica time.
  const start = new Date(`${nextDay(here.date)}T08:00:00-06:00`);
  db.events.push({ id: 9, created_by: 'host', title: 'Copa', course: 'Cariari', starts_at: start.toISOString(), time_zone: 'America/Costa_Rica', status: 'open', max_players: 10, price_colones: 1 });
  db.event_registrations.push({ event_id: 9, user_id: 'caro', status: 'confirmed' });
  await n.tick();
  const got = sent.filter(s => s.userId === 'caro' && s.title.startsWith('Mañana'));
  if (here.hour >= 18 && here.hour < 22) assert.strictEqual(got.length, 1);
  else assert.strictEqual(got.length, 0, 'only in the evening');
});
