// Groups: creating, joining by invite or by request, who sees group rounds,
// opening spots to everyone, weekly rounds, notifications and removal.
const test = require('node:test');
const assert = require('node:assert');
const { makeGroups, nextWeeklyDate } = require('../groups');
const { makeFakeSupabase } = require('./fakeSupabase');

function setup() {
  const db = {
    users: ['ana', 'beto', 'carla', 'dani'].map(id => ({ user_id: id, name: id.toUpperCase(), handicap: 10 })),
    groups: [], group_members: [], group_messages: [], teetimes: [], blocks: [], user_reports: [],
  };
  const supabase = makeFakeSupabase(db);
  const pushes = [];
  const opened = [];
  let n = 0;
  const groups = makeGroups({
    supabase,
    places: { fields: () => ({ place: null, placeFull: null }) },
    photoOf: () => null,
    getUser: async id => db.users.find(u => u.user_id === id) || null,
    isBanned: async () => false,
    BANNED_ERROR: { error: 'banned' },
    moderateFields: () => null,
    getBlockedUserIds: async id => new Set(db.blocks.filter(b => b.blocker_id === id || b.blocked_id === id).map(b => (b.blocker_id === id ? b.blocked_id : b.blocker_id))),
    idsBlockedBy: async id => new Set(db.blocks.filter(b => b.blocker_id === id).map(b => b.blocked_id)),
    getBannedUserIds: async () => new Set(),
    notifyUser: async (userId, message) => { pushes.push({ userId, text: message('en')[0] }); },
    geocodeCourse: async () => ({ lat: 9.93, lng: -84.18 }),
    haversineMiles: () => 1,
    DEMO_USER_IDS: new Set(),
    buildTeetimeResponse: async row => ({ id: row.id, hostId: row.host_id, date: row.date }),
    insertRound: async f => {
      const row = { id: 'tt' + (++n), host_id: f.hostId, course: f.course, date: f.date, time: f.time, status: 'active',
        requests: [], open_spots: f.totalSpots, group_id: f.groupId || null, open_to_all: !!f.openToAll };
      db.teetimes.push(row);
      return row;
    },
    cancelRoundRow: async row => { row.status = 'cancelled'; },
    newRoundForEveryone: row => opened.push(row.id),
  });
  const routes = {};
  const app = {};
  for (const m of ['get', 'post', 'delete']) app[m] = (p, h) => (routes[`${m.toUpperCase()} ${p}`] = h);
  let me = null;
  groups.registerRoutes(app, { ah: fn => fn, verifiedUserId: () => me, requireOwner: (req, res) => me === 'owner' || (res.status(403).json({}), false) });
  async function call(method, path, userId, { params = {}, body = {}, query = {} } = {}) {
    me = userId;
    let status = 200, out;
    const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; } };
    const h = routes[`${method} ${path}`];
    assert.ok(h, `no route ${method} ${path}`);
    await h({ params, body, query, lang: 'en' }, res);
    return { status, body: out };
  }
  return { db, groups, call, pushes, opened };
}

test('next weekly date: today only if the time has not passed (course time)', () => {
  // 2026-11-14 is a Saturday. 15:00 UTC = 09:00 in Costa Rica (lng -84 → UTC-6).
  const at = Date.parse('2026-11-14T15:00:00Z');
  assert.strictEqual(nextWeeklyDate(6, '10:00', -84, at), '2026-11-14', 'later today');
  assert.strictEqual(nextWeeklyDate(6, '07:00', -84, at), '2026-11-21', 'already passed: next week');
  assert.strictEqual(nextWeeklyDate(0, '07:00', -84, at), '2026-11-15', 'Sunday');
  assert.strictEqual(nextWeeklyDate(5, '07:00', -84, at), '2026-11-20', 'Friday');
});

test('create, invite link, ask to join and approve', async () => {
  const { db, call, pushes } = setup();
  const made = await call('POST', '/api/groups', 'ana', { body: { name: 'Sábados en Valle del Sol', homeCourse: 'Valle del Sol', description: 'Salida 7 am' } });
  assert.strictEqual(made.status, 200);
  const g = made.body;
  assert.ok(g.inviteLink.endsWith('/g/' + db.groups[0].invite_code));
  assert.strictEqual(g.memberCount, 1);

  // Beto joins with the link: in straight away.
  const code = db.groups[0].invite_code;
  assert.strictEqual((await call('POST', '/api/groups/invite/:code/join', 'beto', { params: { code } })).body.joined, true);

  // Carla asks; not a member until Ana approves.
  await call('POST', '/api/groups/:id/request', 'carla', { params: { id: g.id } });
  assert.ok(pushes.some(p => p.userId === 'ana' && p.text === 'New group request'));
  let view = (await call('GET', '/api/groups/:id', 'carla', { params: { id: g.id } })).body;
  assert.strictEqual(view.myStatus, 'pending');
  assert.strictEqual(view.members, undefined, 'no member list before joining');
  const asCreator = (await call('GET', '/api/groups/:id', 'ana', { params: { id: g.id } })).body;
  assert.deepStrictEqual(asCreator.pending.map(p => p.id), ['carla']);
  assert.strictEqual((await call('POST', '/api/groups/:id/members/:userId', 'beto', { params: { id: g.id, userId: 'carla' }, body: { action: 'approve' } })).status, 403, 'only the creator approves');
  await call('POST', '/api/groups/:id/members/:userId', 'ana', { params: { id: g.id, userId: 'carla' }, body: { action: 'approve' } });
  view = (await call('GET', '/api/groups/:id', 'carla', { params: { id: g.id } })).body;
  assert.strictEqual(view.myStatus, 'member');
  assert.deepStrictEqual(view.members.map(m => m.id), ['ana', 'beto', 'carla'], 'creator first');
  assert.strictEqual(view.inviteLink, null, 'only the creator gets the invite link');

  const mine = (await call('GET', '/api/groups/mine', 'beto')).body.groups;
  assert.deepStrictEqual(mine.map(x => x.name), ['Sábados en Valle del Sol']);
  const found = (await call('GET', '/api/groups/discover', 'dani', { query: {} })).body.groups;
  assert.deepStrictEqual(found.map(x => x.id), [g.id]);
  assert.deepStrictEqual((await call('GET', '/api/groups/discover', 'beto', { query: {} })).body.groups, [], 'not my own groups');
});

test('group rounds: members first, then open to everyone', async () => {
  const { db, groups, call, opened } = setup();
  const g = (await call('POST', '/api/groups', 'ana', { body: { name: 'Martes', homeCourse: 'Cariari' } })).body;
  await call('POST', '/api/groups/invite/:code/join', 'beto', { params: { code: db.groups[0].invite_code } });
  const row = { id: 'r1', host_id: 'beto', group_id: g.id, open_to_all: false, requests: [], status: 'active', date: '2099-01-01', time: '08:00' };
  db.teetimes.push(row);

  const visFor = async who => groups.roundVisible(row, who, await groups.visibility(who));
  assert.strictEqual(await visFor('ana'), true, 'member');
  assert.strictEqual(await visFor('beto'), true, 'host');
  assert.strictEqual(await visFor('carla'), false, 'not a member');
  assert.strictEqual(await groups.canJoinRound(row, 'carla'), false);

  assert.strictEqual((await call('POST', '/api/teetimes/:id/open-to-all', 'carla', { params: { id: 'r1' } })).status, 403);
  await call('POST', '/api/teetimes/:id/open-to-all', 'ana', { params: { id: 'r1' } }); // the group's creator
  assert.strictEqual(row.open_to_all, true);
  assert.deepStrictEqual(opened, ['r1'], 'nearby golfers are told once it opens');
  assert.strictEqual(await visFor('carla'), true);
  assert.strictEqual(await groups.canJoinRound(row, 'carla'), true);
});

test('weekly round: posted once per week, members notified (switch respected)', async () => {
  const { db, groups, call, pushes } = setup();
  const g = (await call('POST', '/api/groups', 'ana', { body: { name: 'Sábados', homeCourse: 'Valle del Sol' } })).body;
  for (const who of ['beto', 'carla']) await call('POST', '/api/groups/invite/:code/join', who, { params: { code: db.groups[0].invite_code } });
  await call('POST', '/api/groups/:id/notify', 'carla', { params: { id: g.id }, body: { on: false } });

  assert.strictEqual((await call('POST', '/api/groups/:id/weekly', 'beto', { params: { id: g.id }, body: { enabled: true, day: 6, time: '07:00', spots: 3 } })).status, 403);
  await call('POST', '/api/groups/:id/weekly', 'ana', { params: { id: g.id }, body: { enabled: true, day: 6, time: '07:00', spots: 3 } });
  assert.strictEqual(db.teetimes.length, 1, 'posted right away');
  assert.strictEqual(db.teetimes[0].group_id, g.id);
  assert.strictEqual(db.teetimes[0].open_to_all, false);
  assert.strictEqual(new Date(db.teetimes[0].date + 'T12:00:00Z').getUTCDay(), 6, 'a Saturday');

  assert.strictEqual(await groups.postWeeklyRounds(), 0, 'not twice');
  assert.deepStrictEqual(pushes.filter(p => p.text === 'New round in Sábados').map(p => p.userId), ['beto'], 'not the host, not Carla (switched off)');

  // A week later the next one goes up.
  const nextWeek = Date.now() + 7 * 24 * 3600e3;
  assert.strictEqual(await groups.postWeeklyRounds(nextWeek), 1);
  assert.strictEqual(db.teetimes.length, 2);
});

test('group chat: members only, blocked people hidden; reports; removal', async () => {
  const { db, groups, call, pushes } = setup();
  const g = (await call('POST', '/api/groups', 'ana', { body: { name: 'Martes', homeCourse: 'Cariari' } })).body;
  for (const who of ['beto', 'carla']) await call('POST', '/api/groups/invite/:code/join', who, { params: { code: db.groups[0].invite_code } });

  assert.strictEqual((await call('GET', '/api/groups/:id/messages', 'dani', { params: { id: g.id } })).status, 403);
  await call('POST', '/api/groups/:id/messages', 'beto', { params: { id: g.id }, body: { text: 'Hola!' } });
  assert.deepStrictEqual(pushes.filter(p => p.text === 'BETO · Martes').map(p => p.userId).sort(), ['ana', 'carla']);

  db.blocks.push({ blocker_id: 'carla', blocked_id: 'beto' });
  assert.strictEqual((await call('GET', '/api/groups/:id/messages', 'carla', { params: { id: g.id } })).body.length, 0);
  assert.strictEqual((await call('GET', '/api/groups/:id/messages', 'ana', { params: { id: g.id } })).body.length, 1);

  const msgId = db.group_messages[0].id;
  assert.strictEqual((await groups.reportTarget({ groupMessageId: msgId }, 'dani')).status, 403, 'not a member');
  assert.strictEqual((await groups.reportTarget({ groupMessageId: msgId }, 'ana')).reportedId, 'beto');
  assert.strictEqual((await groups.reportTarget({ groupId: g.id }, 'dani')).reportedId, 'ana', 'a group name reports its creator');

  // The owner removes it: gone, and its members-only rounds are cancelled.
  db.teetimes.push({ id: 'r1', host_id: 'beto', group_id: g.id, open_to_all: false, status: 'active', date: '2099-01-01', requests: [] });
  db.teetimes.push({ id: 'r2', host_id: 'beto', group_id: g.id, open_to_all: true, status: 'active', date: '2099-01-01', requests: [] });
  assert.strictEqual((await call('POST', '/api/admin/groups/:id/remove', 'ana', { params: { id: g.id } })).status, 403, 'owner only');
  await call('POST', '/api/admin/groups/:id/remove', 'owner', { params: { id: g.id } });
  assert.ok(db.groups[0].removed_at);
  assert.strictEqual(db.teetimes[0].status, 'cancelled');
  assert.strictEqual(db.teetimes[1].status, 'active', 'already open to everyone: kept');
  assert.strictEqual((await call('GET', '/api/groups/:id', 'beto', { params: { id: g.id } })).status, 404);
  assert.deepStrictEqual((await call('GET', '/api/groups/mine', 'beto')).body.groups, []);
});

test('before supabase-groups.sql: a clear message', async () => {
  const supabase = makeFakeSupabase({}, { missingColumns: { groups: ['*', 'id'], group_members: ['*', 'group_id'] } });
  const groups = makeGroups({ supabase, places: { fields: () => ({}) }, photoOf: () => null, DEMO_USER_IDS: new Set(), getBlockedUserIds: async () => new Set() });
  const routes = {};
  const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h), delete: () => {} };
  groups.registerRoutes(app, { ah: fn => fn, verifiedUserId: () => 'ana', requireOwner: () => false });
  let status, body;
  const res = { status(c) { status = c; return res; }, json(b) { body = b; return res; } };
  await routes['GET /api/groups/mine']({ params: {}, query: {}, body: {} }, res);
  assert.strictEqual(status, 503);
  assert.strictEqual(body.error, 'Groups aren’t set up yet');
  const vis = await groups.visibility('ana');
  assert.strictEqual(groups.roundVisible({ host_id: 'x', requests: [] }, 'ana', vis), true, 'normal rounds unaffected');
});
