// Partner course pages: the right rounds and events, and the poster's QR code.
const test = require('node:test');
const assert = require('node:assert');
const { makePartners, slugify } = require('../partners');
const { makeFakeSupabase } = require('./fakeSupabase');

const inDays = n => new Date(Date.now() + n * 24 * 3600e3).toISOString();

test('slugs', () => {
  assert.strictEqual(slugify('Valle del Sol (Santa Ana)'), 'valle-del-sol-santa-ana');
  assert.strictEqual(slugify('Cariari Country Club'), 'cariari-country-club');
  assert.strictEqual(slugify('Ñandú Golf'), 'nandu-golf');
});

function setup() {
  const db = {
    partner_courses: [],
    teetimes: [
      { id: 'a', host_id: 'ana', host_name: 'Ana', course: 'Valle del Sol', lat: 9.92, lng: -84.18, date: inDays(2).slice(0, 10), time: '07:00', open_spots: 2, status: 'active' },
      { id: 'b', host_id: 'beto', host_name: 'Beto', course: 'Valle del Sol (Santa Ana)', lat: 9.921, lng: -84.181, date: inDays(3).slice(0, 10), time: '08:00', open_spots: 1, status: 'active' },
      { id: 'group', host_id: 'beto', host_name: 'Beto', course: 'Valle del Sol', date: inDays(3).slice(0, 10), time: '08:00', open_spots: 1, status: 'active', group_id: 'g1', open_to_all: false },
      { id: 'far', host_id: 'ana', host_name: 'Ana', course: 'Cariari', lat: 9.97, lng: -84.15, date: inDays(2).slice(0, 10), time: '07:00', open_spots: 2, status: 'active' },
      { id: 'demo', host_id: 'demo', host_name: 'Demo', course: 'Valle del Sol', date: inDays(2).slice(0, 10), time: '07:00', open_spots: 2, status: 'active' },
      { id: 'full', host_id: 'ana', host_name: 'Ana', course: 'Valle del Sol', date: inDays(2).slice(0, 10), time: '07:00', open_spots: 0, status: 'active' },
    ],
    events: [{ id: 1, title: 'Copa', course: 'Valle del Sol', lat: 9.92, lng: -84.18, status: 'open', starts_at: inDays(10), time_zone: 'America/Costa_Rica', price_colones: 25000 }],
  };
  const supabase = makeFakeSupabase(db);
  const partners = makePartners({ supabase, DEMO_USER_IDS: new Set(['demo']), getBannedUserIds: async () => new Set() });
  const routes = {};
  const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) };
  partners.registerRoutes(app, { ah: fn => fn, requireOwner: () => true });
  async function call(method, path, { params = {}, body = {}, query = {} } = {}) {
    let status = 200, out;
    const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; }, send(b) { out = b; return res; }, set() { return res; } };
    await routes[`${method} ${path}`]({ params, body, query, headers: { 'accept-language': 'en' } }, res);
    return { status, body: out };
  }
  return { db, partners, call };
}

test('a partner page lists open rounds and events at that course only', async () => {
  const { partners, call } = setup();
  const added = (await call('POST', '/api/admin/partners', { body: { name: 'Valle del Sol', lat: 9.92, lng: -84.18 } })).body;
  assert.strictEqual(added.slug, 'valle-del-sol');
  assert.ok(added.posterUrl.endsWith('/c/valle-del-sol/poster'));
  const { rounds, events } = await partners.upcomingAt({ name: 'Valle del Sol', lat: 9.92, lng: -84.18 }, 'en');
  assert.deepStrictEqual(rounds.map(r => r.id), ['a', 'b'], 'nearby name variant yes; members-only, other course, demo and full no');
  assert.deepStrictEqual(events.map(e => e.id), [1]);

  const page = await call('GET', '/c/:slug', { params: { slug: 'valle-del-sol' } });
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes('Open rounds') && page.body.includes('/r/a') && page.body.includes('Copa'));
  const poster = await call('GET', '/c/:slug/poster', { params: { slug: 'valle-del-sol' }, query: { lang: 'es' } });
  assert.ok(poster.body.includes('<svg') && poster.body.includes('¿Buscás con quién jugar?'));

  await call('POST', '/api/admin/partners/:id/remove', { params: { id: 1000 } });
  assert.strictEqual((await call('GET', '/c/:slug', { params: { slug: 'valle-del-sol' } })).status, 404);
});
