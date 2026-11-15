// Manage > Dashboard numbers, before and after supabase-dashboard.sql.
const test = require('node:test');
const assert = require('node:assert');
const { registerEventRoutes } = require('../events');
const { makeFakeSupabase } = require('./fakeSupabase');

const DAY = 24 * 3600e3;
function setup(missingColumns) {
  const now = Date.now();
  const db = {
    users: [
      { user_id: 'a', created_at: now - 2 * DAY, terms_agreed_at: now - 2 * DAY },
      { user_id: 'b', created_at: now - 30 * DAY },
      { user_id: 'c', created_at: null, terms_agreed_at: now - 1 * DAY },
      { user_id: 'demo1', created_at: now },
    ],
    teetimes: [{ id: 't1', created_at: now - DAY }, { id: 't2', created_at: now - 10 * DAY }],
    events: [{ id: 1, title: 'Copa', course: 'Cariari', status: 'open', starts_at: new Date(now + 5 * DAY).toISOString(), time_zone: 'America/Costa_Rica', price_colones: 25000, max_players: 20 }],
    event_registrations: [
      { event_id: 1, user_id: 'a', status: 'confirmed', amount_colones: 25000 },
      { event_id: 1, user_id: 'b', status: 'confirmed', amount_colones: 25000 },
      { event_id: 1, user_id: 'c', status: 'refunded', amount_colones: 25000 },
    ],
    event_requests: [{ id: 5, user_name: 'Ana', course: 'Pinilla', note: '', created_at: new Date().toISOString(), handled_at: null }],
    user_reports: [{ id: 9, reporter_id: 'a', reported_id: 'b', reason: 'rude', created_at: now, resolved_at: null }],
  };
  const supabase = makeFakeSupabase(db, { missingColumns });
  const routes = {};
  const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) };
  registerEventRoutes(app, { supabase, ah: f => f, verifiedUserId: () => 'owner', DEMO_USER_IDS: new Set(['demo1']) });
  const admin = { authUser: { id: 'owner', email: 'foursomeapp.golf@gmail.com', email_confirmed_at: '2026-01-01' }, lang: 'en', params: {}, body: {}, query: {}, headers: {} };
  async function call(key, req = {}) {
    let status = 200, out;
    const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; } };
    await routes[key]({ ...admin, ...req }, res);
    return { status, body: out };
  }
  return { db, call };
}

test('dashboard numbers', async () => {
  const { call } = setup();
  const { status, body } = await call('GET /api/admin/dashboard');
  assert.strictEqual(status, 200, JSON.stringify(body));
  assert.strictEqual(body.totalUsers, 3, 'demo accounts left out');
  assert.strictEqual(body.signupsThisWeek, 2, 'a (created_at) and c (consent date fallback)');
  assert.strictEqual(body.roundsThisWeek, 1);
  assert.strictEqual(body.upcomingEvents[0].sold, 2);
  assert.strictEqual(body.upcomingEvents[0].revenueColones, 50000, 'refunded spot not counted');
  assert.strictEqual(body.pendingRequests, 1);
  assert.strictEqual(body.openReports.length, 1);
  assert.strictEqual(body.openReports[0].reporter, '?');
  assert.strictEqual(body.ready, true);
});

test('mark handled / resolved drops them from the dashboard', async () => {
  const { call } = setup();
  await call('POST /api/admin/event-requests/:id/handled', { params: { id: 5 } });
  await call('POST /api/admin/reports/:id/resolve', { params: { id: 9 } });
  const { body } = await call('GET /api/admin/dashboard');
  assert.strictEqual(body.pendingRequests, 0);
  assert.strictEqual(body.openReports.length, 0);
});

test('before supabase-dashboard.sql: still works, everything counts as open', async () => {
  const { call } = setup({ event_requests: ['handled_at'], user_reports: ['resolved_at'] });
  const { status, body } = await call('GET /api/admin/dashboard');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.pendingRequests, 1);
  assert.strictEqual(body.openReports.length, 1);
  assert.strictEqual(body.ready, false);
});
