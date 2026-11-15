// Friends: only after playing together, request → accept, blocking ends it,
// and inviting friends to a round.
const test = require('node:test');
const assert = require('node:assert');
const { makeFriends } = require('../friends');
const { makeFakeSupabase } = require('./fakeSupabase');

const day = n => new Date(Date.now() - n * 24 * 3600e3).toISOString().slice(0, 10);

function setup() {
  const db = {
    users: ['ana', 'beto', 'carla', 'dani'].map(id => ({ user_id: id, name: id.toUpperCase(), handicap: 10 })),
    teetimes: [
      { id: 'past', host_id: 'ana', date: day(3), status: 'active', requests: [{ userId: 'beto', status: 'approved' }, { userId: 'dani', status: 'pending' }] },
      { id: 'future', host_id: 'ana', date: day(-3), status: 'active', requests: [{ userId: 'dani', status: 'approved' }] },
    ],
    events: [{ id: 1, starts_at: new Date(Date.now() - 86400e3).toISOString() }],
    event_registrations: [{ event_id: 1, user_id: 'ana', status: 'confirmed' }, { event_id: 1, user_id: 'carla', status: 'confirmed' }],
    friendships: [], blocks: [],
  };
  const supabase = makeFakeSupabase(db, { unique: { friendships: ['user_a', 'user_b'] } });
  const pushes = [];
  const friends = makeFriends({
    supabase, photoOf: () => null,
    getUser: async id => db.users.find(u => u.user_id === id),
    getBlockedUserIds: async id => new Set(db.blocks.filter(b => b.blocker_id === id || b.blocked_id === id).map(b => (b.blocker_id === id ? b.blocked_id : b.blocker_id))),
    getBannedUserIds: async () => new Set(),
    notifyUser: async (userId, message) => { pushes.push({ userId, text: message('en')[1] }); },
  });
  const routes = {};
  const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) };
  let me = null;
  friends.registerRoutes(app, { ah: fn => fn, verifiedUserId: () => me, isBanned: async () => false, BANNED_ERROR: {} });
  async function call(method, path, userId, { params = {}, body = {} } = {}) {
    me = userId;
    let status = 200, out;
    const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; } };
    await routes[`${method} ${path}`]({ params, body, query: {} }, res);
    return { status, body: out };
  }
  return { db, friends, call, pushes };
}

test('played with: past rounds (approved) and past paid events only', async () => {
  const { friends } = setup();
  assert.deepStrictEqual([...(await friends.playedWith('ana'))].sort(), ['beto', 'carla']);
  assert.deepStrictEqual([...(await friends.playedWith('dani'))], [], 'pending request and future round don’t count');
});

test('ask, accept, then blocking ends it', async () => {
  const { db, friends, call, pushes } = setup();
  assert.strictEqual(await friends.statusBetween('ana', 'beto'), 'can_add');
  assert.strictEqual(await friends.statusBetween('ana', 'dani'), null);
  assert.strictEqual((await call('POST', '/api/friends/:userId', 'ana', { params: { userId: 'dani' }, body: { action: 'add' } })).status, 403, 'never played together');

  assert.strictEqual((await call('POST', '/api/friends/:userId', 'ana', { params: { userId: 'beto' }, body: { action: 'add' } })).body.status, 'requested');
  assert.ok(pushes.some(p => p.userId === 'beto' && p.text === 'ANA wants to add you as a friend'));
  assert.strictEqual(await friends.statusBetween('beto', 'ana'), 'incoming');
  let list = (await call('GET', '/api/friends', 'beto')).body;
  assert.deepStrictEqual(list.incoming.map(p => p.id), ['ana']);
  assert.deepStrictEqual(list.suggestions, [], 'not suggested while there is a request');

  await call('POST', '/api/friends/:userId', 'beto', { params: { userId: 'ana' }, body: { action: 'accept' } });
  assert.strictEqual(await friends.statusBetween('ana', 'beto'), 'friends');
  list = (await call('GET', '/api/friends', 'ana')).body;
  assert.deepStrictEqual(list.friends.map(p => p.id), ['beto']);
  assert.deepStrictEqual(list.suggestions.map(p => p.id), ['carla'], 'met at the event');

  db.blocks.push({ blocker_id: 'beto', blocked_id: 'ana' });
  await friends.onBlock('beto', 'ana');
  assert.strictEqual(db.friendships.length, 0);
  assert.strictEqual(await friends.statusBetween('ana', 'beto'), null);
  assert.strictEqual((await call('POST', '/api/friends/:userId', 'ana', { params: { userId: 'beto' }, body: { action: 'add' } })).status, 403);
});

test('inviting friends to a round: only friends, and they are told', async () => {
  const { db, friends, call, pushes } = setup();
  await call('POST', '/api/friends/:userId', 'ana', { params: { userId: 'carla' }, body: { action: 'add' } });
  await call('POST', '/api/friends/:userId', 'carla', { params: { userId: 'ana' }, body: { action: 'add' } }); // asking back = accept
  const row = { id: 'new', host_id: 'ana', course: 'Cariari', date: day(-5), time: '07:00' };
  db.teetimes.push(row);
  const invited = await friends.inviteToRound(row, 'ANA', ['carla', 'dani', 'carla']);
  assert.deepStrictEqual(invited, ['carla'], 'dani is not a friend');
  assert.deepStrictEqual(row.invited_ids, ['carla']);
  assert.ok(pushes.some(p => p.userId === 'carla' && p.text.startsWith('Cariari')));
  assert.strictEqual(friends.isInvited(row, 'carla'), true);
});
