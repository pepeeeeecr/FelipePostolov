// "Did everyone show up?": who's asked, the answers, and the show-up rate
// (majority rule; no rate until 3 rounds).
const test = require('node:test');
const assert = require('node:assert');
const { registerAttendance } = require('../attendance');
const { makeFakeSupabase } = require('./fakeSupabase');

const day = n => new Date(Date.now() - n * 24 * 3600e3).toISOString().slice(0, 10);
const round = (id, date, host, approved) => ({ id, host_id: host, host_name: host, course: 'Cariari', date, time: '08:00', status: 'active',
  requests: approved.map(u => ({ userId: u, name: u, status: 'approved' })) });

function setup(teetimes) {
  const db = { teetimes, round_attendance: [] };
  const supabase = makeFakeSupabase(db, { unique: { round_attendance: ['teetime_id', 'reporter_id'] } });
  const routes = {};
  const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) };
  const ah = fn => fn;
  let me = null;
  const api = registerAttendance(app, { supabase, ah, verifiedUserId: () => me, DEMO_USER_IDS: new Set() });
  async function call(method, path, userId, { params = {}, body = {} } = {}) {
    me = userId;
    let status = 200, out;
    const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; } };
    await routes[`${method} ${path}`]({ params, body }, res);
    return { status, body: out };
  }
  return { db, api, call };
}

test('asks each player once about past rounds, and the answers set the show-up rate', async () => {
  const { api, call } = setup([
    round('r1', day(1), 'host', ['ana', 'beto']),
    round('r2', day(2), 'host', ['ana']),
    round('r3', day(3), 'host', ['ana']),
    round('future', day(-2), 'host', ['ana']),
    round('solo', day(1), 'host', []),
  ]);
  const pending = await call('GET', '/api/attendance/pending', 'ana');
  assert.deepStrictEqual(pending.body.rounds.map(r => r.id).sort(), ['r1', 'r2', 'r3'], 'past rounds with other players only');
  assert.deepStrictEqual(pending.body.rounds.find(r => r.id === 'r1').players.map(p => p.id), ['host', 'beto']);

  // r1: host says beto didn't come, ana says everyone did → 1 of 2: not a majority.
  await call('POST', '/api/teetimes/:id/attendance', 'host', { params: { id: 'r1' }, body: { noShowIds: ['beto'] } });
  await call('POST', '/api/teetimes/:id/attendance', 'ana', { params: { id: 'r1' }, body: { noShowIds: [] } });
  let s = (await api.reliabilityFor(['beto'])).get('beto');
  assert.deepStrictEqual(s, { roundsPlayed: 1, showUpRate: null }, 'one round: no rate yet');

  // Ana: host says she didn't come to r2; came to r1 and r3.
  await call('POST', '/api/teetimes/:id/attendance', 'host', { params: { id: 'r2' }, body: { noShowIds: ['ana'] } });
  await call('POST', '/api/teetimes/:id/attendance', 'host', { params: { id: 'r3' }, body: { noShowIds: [] } });
  s = (await api.reliabilityFor(['ana'])).get('ana');
  assert.deepStrictEqual(s, { roundsPlayed: 2, showUpRate: null }, 'no-show rounds are not "played"; under 3, no rate');

  // Host played 3 rounds; Ana answered about r1 (everyone came): rate 100%.
  s = (await api.reliabilityFor(['host'])).get('host');
  assert.deepStrictEqual(s, { roundsPlayed: 3, showUpRate: 100 });

  // Answered rounds drop out of "pending"; answering twice is harmless.
  assert.deepStrictEqual((await call('GET', '/api/attendance/pending', 'ana')).body.rounds.map(r => r.id).sort(), ['r2', 'r3']);
  const again = await call('POST', '/api/teetimes/:id/attendance', 'ana', { params: { id: 'r1' }, body: { noShowIds: ['beto'] } });
  assert.strictEqual(again.status, 200);
});

test('rejects outsiders, future rounds and players not in the round', async () => {
  const { call } = setup([round('r1', day(1), 'host', ['ana']), round('f', day(-1), 'host', ['ana'])]);
  assert.strictEqual((await call('POST', '/api/teetimes/:id/attendance', 'zed', { params: { id: 'r1' }, body: {} })).status, 403);
  assert.strictEqual((await call('POST', '/api/teetimes/:id/attendance', 'ana', { params: { id: 'f' }, body: {} })).status, 400);
  assert.strictEqual((await call('POST', '/api/teetimes/:id/attendance', 'ana', { params: { id: 'r1' }, body: { noShowIds: ['zed'] } })).status, 400);
  assert.strictEqual((await call('POST', '/api/teetimes/:id/attendance', 'ana', { params: { id: 'r1' }, body: { noShowIds: ['ana'] } })).status, 400);
});
