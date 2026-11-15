// Groups (see supabase-groups.sql).
//
// - Anyone signed in (or a guest) creates a group: a name, a home course and
//   an optional description. The creator is its first member.
// - The creator shares an invite link (/g/<code>): opening it in the app
//   joins straight away. Anyone else can ask to join; the creator approves.
// - Members see the member list, the group chat and the group's rounds.
// - A round posted to a group is only shown to members until its host (or
//   the group's creator) opens the leftover spots to everyone; from then on
//   it's a normal round on Discover.
// - Weekly round: the creator picks a day, time and number of spots, and the
//   next one is posted automatically as soon as the previous one's date has
//   passed (so there's always one upcoming).
// - Members are notified about new group rounds and chat messages, with an
//   on/off switch per group.
// - Group names, descriptions and chat messages can be reported; the owner
//   removes a group from the dashboard. Removing a group (by the owner or the
//   creator) hides it and cancels its upcoming members-only rounds.

const crypto = require('crypto');

const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const MAX_GROUPS_CREATED = 10;
const WEEKLY_CHECK_MS = 10 * 60 * 1000;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://felipepostolov.onrender.com';
const DAY_NAMES = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};

const NOT_READY = 'Groups aren’t set up yet';
const tableMissing = e => !!e && /group|open_to_all|does not exist|schema cache|relation/i.test(e.message || '');

// The course's local time, from its longitude (good to the hour, which is
// all a weekly round needs). Costa Rica when the course has no location.
function localNow(lng, now = Date.now()) {
  const offsetHours = Number.isFinite(lng) ? Math.round(lng / 15) : -6;
  return new Date(now + offsetHours * 3600e3);
}
const ymd = d => d.toISOString().slice(0, 10);
const hhmm = d => d.toISOString().slice(11, 16);

// The next date (YYYY-MM-DD) that falls on `day` at `time` or later, in the
// course's local time. Today counts only if that time hasn't passed yet.
function nextWeeklyDate(day, time, lng, now = Date.now()) {
  const local = localNow(lng, now);
  let diff = (Number(day) - local.getUTCDay() + 7) % 7;
  if (diff === 0 && String(time) <= hhmm(local)) diff = 7;
  return ymd(new Date(local.getTime() + diff * 24 * 3600e3));
}

const validTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const newCode = () => crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).padEnd(8, 'x');
const newId = () => 'g_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

function makeGroups(deps) {
  const {
    supabase, places, photoOf, getUser, isBanned, BANNED_ERROR, moderateFields,
    getBlockedUserIds, idsBlockedBy, getBannedUserIds, notifyUser, geocodeCourse, haversineMiles,
    buildTeetimeResponse, insertRound, cancelRoundRow, newRoundForEveryone,
  } = deps;
  // Read when used: server.js defines DEMO_USER_IDS after making this.
  const isDemo = id => deps.DEMO_USER_IDS.has(id);
  const demoMismatch = (a, b) => isDemo(a) !== isDemo(b);
  let warned = false;
  function warn(e) {
    if (!warned) console.warn('Groups are off until supabase-groups.sql is run:', e.message);
    warned = true;
  }
  const todayish = () => ymd(new Date(Date.now() - 24 * 3600e3)); // rounds count as upcoming until the day after

  // --- Reading -------------------------------------------------------------
  async function getGroup(id) {
    const { data, error } = await supabase.from('groups').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data && !data.removed_at ? data : null;
  }

  async function membersOf(groupId) {
    const { data, error } = await supabase.from('group_members').select('*').eq('group_id', groupId);
    if (error) throw error;
    return data || [];
  }

  async function membershipOf(groupId, userId) {
    if (!userId) return null;
    const { data, error } = await supabase.from('group_members').select('*').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  // For GET /api/teetimes: which groups this person is a member of, and every
  // live group's name. Empty (so group rounds stay hidden from everyone but
  // their host) if the tables aren't there.
  async function visibility(viewerId) {
    const out = { memberOf: new Set(), names: new Map() };
    try {
      const { data: groups, error } = await supabase.from('groups').select('id, name, creator_id, removed_at');
      if (error) throw error;
      for (const g of groups || []) if (!g.removed_at) out.names.set(g.id, { name: g.name, creatorId: g.creator_id });
      if (viewerId) {
        const { data: mine, error: mErr } = await supabase.from('group_members').select('group_id, status').eq('user_id', viewerId);
        if (mErr) throw mErr;
        for (const m of mine || []) if (m.status === 'member') out.memberOf.add(m.group_id);
      }
    } catch (e) { if (tableMissing(e)) warn(e); else console.error('Group visibility failed:', e.message); }
    return out;
  }

  // Whether a round is shown to this viewer, and the group fields it gets.
  function roundVisible(row, viewerId, vis) {
    if (!row.group_id) return true;
    if (row.host_id === viewerId) return true;
    if (viewerId && (row.requests || []).some(r => r.userId === viewerId)) return true;
    if (!vis.names.has(row.group_id)) return false; // group removed
    return !!row.open_to_all || vis.memberOf.has(row.group_id);
  }
  function roundGroupFields(row, vis) {
    if (!row.group_id) return {};
    const g = vis.names.get(row.group_id);
    return { groupId: row.group_id, groupName: g ? g.name : null, openToAll: !!row.open_to_all, canOpen: false };
  }

  async function canJoinRound(row, userId) {
    if (!row.group_id || row.open_to_all || row.host_id === userId) return true;
    const m = await membershipOf(row.group_id, userId).catch(() => null);
    return !!(m && m.status === 'member');
  }

  function weeklyJson(g, lang) {
    if (!g.weekly_enabled || g.weekly_day == null || !g.weekly_time) return null;
    const names = DAY_NAMES[lang === 'en' ? 'en' : 'es'];
    return { day: g.weekly_day, time: g.weekly_time, spots: g.weekly_spots || 3, dayName: names[g.weekly_day] };
  }

  function groupJson(g, { memberCount, me, viewerId, lang, creatorName }) {
    const isCreator = g.creator_id === viewerId;
    const isMember = !!(me && me.status === 'member');
    return {
      id: g.id,
      name: g.name,
      homeCourse: g.home_course,
      lat: g.course_lat, lng: g.course_lng,
      description: g.description || '',
      creatorId: g.creator_id,
      creatorName: creatorName || null,
      creatorPhotoUrl: photoOf(g.creator_id),
      memberCount,
      myStatus: me ? me.status : null, // 'member' | 'pending' | null
      isCreator,
      notify: isMember ? me.notify !== false : null,
      weekly: isMember ? weeklyJson(g, lang) : null,
      inviteLink: isCreator ? `${PUBLIC_URL}/g/${g.invite_code}` : null,
      ...places.fields(g.course_lat, g.course_lng, lang),
    };
  }

  async function namesOf(ids) {
    if (!ids.length) return new Map();
    const { data } = await supabase.from('users').select('user_id, name, handicap, banned').in('user_id', ids);
    return new Map((data || []).map(u => [u.user_id, u]));
  }

  async function summaries(groups, viewerId, lang) {
    if (!groups.length) return [];
    const ids = groups.map(g => g.id);
    const { data: rows, error } = await supabase.from('group_members').select('group_id, user_id, status, notify').in('group_id', ids);
    if (error) throw error;
    const users = await namesOf([...new Set(groups.map(g => g.creator_id))]);
    return groups.map(g => {
      const members = (rows || []).filter(r => r.group_id === g.id);
      return groupJson(g, {
        memberCount: members.filter(m => m.status === 'member').length,
        me: members.find(m => m.user_id === viewerId) || null,
        viewerId, lang,
        creatorName: (users.get(g.creator_id) || {}).name,
      });
    });
  }

  // --- Changing ------------------------------------------------------------
  // Hides the group and cancels its upcoming members-only rounds.
  async function removeGroup(g) {
    const { error } = await supabase.from('groups').update({ removed_at: new Date().toISOString(), weekly_enabled: false }).eq('id', g.id);
    if (error) throw error;
    const { data: rounds } = await supabase.from('teetimes').select('*').eq('group_id', g.id).neq('status', 'cancelled').gte('date', todayish());
    for (const rd of rounds || []) if (!rd.open_to_all) await cancelRoundRow(rd).catch(() => {});
  }

  // Account deletion: their groups and everything in them go, and they're
  // taken out of everyone else's groups and chats.
  async function deleteUserData(userId) {
    try {
      const { data: created, error } = await supabase.from('groups').select('*').eq('creator_id', userId);
      if (error) throw error;
      for (const g of created || []) {
        await removeGroup(g).catch(() => {});
        await supabase.from('group_messages').delete().eq('group_id', g.id);
        await supabase.from('group_members').delete().eq('group_id', g.id);
        await supabase.from('groups').delete().eq('id', g.id);
      }
      await supabase.from('group_messages').delete().eq('sender_id', userId);
      await supabase.from('group_members').delete().eq('user_id', userId);
    } catch (e) {
      if (!tableMissing(e)) throw e;
    }
  }

  // --- Notifications --------------------------------------------------------
  async function notifyMembers(groupId, exceptId, message, url) {
    const members = (await membersOf(groupId)).filter(m => m.status === 'member' && m.user_id !== exceptId && m.notify !== false);
    if (!members.length) return;
    const blockedWith = exceptId ? await getBlockedUserIds(exceptId).catch(() => new Set()) : new Set();
    for (const m of members) {
      if (blockedWith.has(m.user_id)) continue;
      await notifyUser(m.user_id, message, null, { data: { url } }).catch(() => {});
    }
  }

  async function newGroupRound(row) {
    try {
      const g = await getGroup(row.group_id);
      if (!g) return;
      await notifyMembers(g.id, row.host_id, lang => lang === 'en'
        ? [`New round in ${g.name}`, `${row.course} · ${row.date} · ${row.time}`]
        : [`Ronda nueva en ${g.name}`, `${row.course} · ${row.date} · ${row.time}`],
      `foursomemobile://group/${encodeURIComponent(g.id)}`);
    } catch (e) { if (!tableMissing(e)) console.error('Group round notifications failed:', e.message); }
  }

  // --- Weekly rounds --------------------------------------------------------
  async function postWeeklyRounds(now = Date.now()) {
    let groups;
    try {
      const { data, error } = await supabase.from('groups').select('*').eq('weekly_enabled', true);
      if (error) throw error;
      groups = (data || []).filter(g => !g.removed_at);
    } catch (e) { if (tableMissing(e)) warn(e); else console.error('Weekly rounds failed:', e.message); return 0; }
    let posted = 0;
    for (const g of groups) {
      try {
        if (g.weekly_day == null || !validTime(g.weekly_time)) continue;
        const date = nextWeeklyDate(g.weekly_day, g.weekly_time, g.course_lng, now);
        if (g.weekly_last_date && date <= g.weekly_last_date) continue;
        const host = await getUser(g.creator_id);
        if (!host || host.banned) continue;
        // Claim this date first, so two checks can never post it twice.
        const { error: claimErr } = await supabase.from('groups').update({ weekly_last_date: date }).eq('id', g.id);
        if (claimErr) throw claimErr;
        const spots = Math.min(4, Math.max(1, Number(g.weekly_spots) || 3));
        const row = await insertRound({
          hostId: g.creator_id, hostName: host.name, hostHandicap: host.handicap,
          course: g.home_course, geo: g.course_lat != null ? { lat: g.course_lat, lng: g.course_lng } : null,
          date, time: g.weekly_time, totalSpots: spots, hcpRange: '', pace: '', notes: '',
          groupId: g.id, openToAll: false,
        });
        posted++;
        await newGroupRound(row);
      } catch (e) {
        console.error('Weekly round for group', g.id, 'failed:', e.message);
      }
    }
    return posted;
  }

  function start() {
    setTimeout(() => postWeeklyRounds().catch(() => {}), 30 * 1000).unref();
    setInterval(() => postWeeklyRounds().catch(() => {}), WEEKLY_CHECK_MS).unref();
  }

  // --- Routes ---------------------------------------------------------------
  function registerRoutes(app, { ah, verifiedUserId, requireOwner }) {
    // Wraps a route: sign-in required, and a clear 503 before the SQL is run.
    const route = (fn, { write = false } = {}) => ah(async (req, res) => {
      const userId = verifiedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Sign in required' });
      if (write && await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
      try {
        await fn(req, res, userId);
      } catch (e) {
        if (tableMissing(e)) { warn(e); return res.status(503).json({ error: NOT_READY }); }
        throw e;
      }
    });
    const loadOr404 = async (req, res) => {
      const g = await getGroup(req.params.id);
      if (!g) res.status(404).json({ error: 'This group no longer exists' });
      return g;
    };
    const creatorOnly = (g, userId, res) => {
      if (g.creator_id === userId) return true;
      res.status(403).json({ error: 'Only the group’s creator can do that' });
      return false;
    };
    const memberOnly = async (g, userId, res) => {
      const me = await membershipOf(g.id, userId);
      if (me && me.status === 'member') return me;
      res.status(403).json({ error: 'Only members can see this' });
      return null;
    };

    // My groups (member or asked to join).
    app.get('/api/groups/mine', route(async (req, res, userId) => {
      const { data: mine, error } = await supabase.from('group_members').select('group_id').eq('user_id', userId);
      if (error) throw error;
      const ids = (mine || []).map(m => m.group_id);
      if (!ids.length) return res.json({ groups: [] });
      const { data: groups, error: gErr } = await supabase.from('groups').select('*').in('id', ids);
      if (gErr) throw gErr;
      const live = (groups || []).filter(g => !g.removed_at).sort((a, b) => a.name.localeCompare(b.name));
      res.json({ groups: await summaries(live, userId, req.lang) });
    }));

    // Groups to join: nearest first (to ?lat&lng, or the home course), or
    // matching ?q in the name or course.
    app.get('/api/groups/discover', route(async (req, res, userId) => {
      const { data: groups, error } = await supabase.from('groups').select('*');
      if (error) throw error;
      const [blocked, banned, myRows] = await Promise.all([
        getBlockedUserIds(userId), getBannedUserIds(),
        supabase.from('group_members').select('group_id').eq('user_id', userId),
      ]);
      const mine = new Set((myRows.data || []).map(m => m.group_id));
      const q = String(req.query.q || '').trim().toLowerCase();
      const lat = Number(req.query.lat), lng = Number(req.query.lng);
      const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      let list = (groups || []).filter(g => !g.removed_at && !mine.has(g.id) && !blocked.has(g.creator_id) &&
        !banned.has(g.creator_id) && !demoMismatch(userId, g.creator_id));
      if (q) list = list.filter(g => `${g.name} ${g.home_course}`.toLowerCase().includes(q));
      const dist = g => (here && g.course_lat != null ? haversineMiles(here.lat, here.lng, g.course_lat, g.course_lng) : Infinity);
      list.sort((a, b) => dist(a) - dist(b) || Number(b.created_at) - Number(a.created_at));
      if (here && !q) list = list.filter(g => dist(g) <= 100 / 1.609 * 1.5 || g.course_lat == null); // ~150 km
      res.json({ groups: await summaries(list.slice(0, 30), userId, req.lang) });
    }));

    app.post('/api/groups', route(async (req, res, userId) => {
      const name = String(req.body.name || '').trim();
      const homeCourse = String(req.body.homeCourse || '').trim();
      const description = String(req.body.description || '').trim();
      if (!name || name.length > MAX_NAME) return res.status(400).json({ error: 'Give the group a name (up to 60 characters)' });
      if (!homeCourse) return res.status(400).json({ error: 'Course is required' });
      if (description.length > MAX_DESCRIPTION) return res.status(400).json({ error: 'Description is too long (300 characters max)' });
      const modError = moderateFields([name, homeCourse, description]);
      if (modError) return res.status(400).json(modError);
      const { count, error: cErr } = await supabase.from('groups').select('id', { count: 'exact', head: true }).eq('creator_id', userId).is('removed_at', null);
      if (cErr) throw cErr;
      if ((count || 0) >= MAX_GROUPS_CREATED) return res.status(400).json({ error: 'You’ve created the most groups allowed (10)' });
      const geo = await geocodeCourse(homeCourse, req.body);
      const g = {
        id: newId(), name, home_course: homeCourse, description,
        course_lat: geo ? geo.lat : null, course_lng: geo ? geo.lng : null,
        creator_id: userId, invite_code: newCode(), created_at: Date.now(),
      };
      const { error } = await supabase.from('groups').insert(g);
      if (error) throw error;
      const { error: mErr } = await supabase.from('group_members').insert({ group_id: g.id, user_id: userId, status: 'member', created_at: Date.now() });
      if (mErr) throw mErr;
      const me = await getUser(userId);
      res.json(groupJson(g, { memberCount: 1, me: { status: 'member', notify: true }, viewerId: userId, lang: req.lang, creatorName: me && me.name }));
    }, { write: true }));

    // A group: everyone sees its name, course, description, creator and
    // size; members also get the member list and its rounds; the creator
    // also gets the people asking to join.
    app.get('/api/groups/:id', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      const rows = await membersOf(g.id);
      const people = await namesOf(rows.map(r => r.user_id));
      const me = rows.find(r => r.user_id === userId) || null;
      const isMember = !!(me && me.status === 'member');
      if (!isMember && demoMismatch(userId, g.creator_id)) return res.status(404).json({ error: 'This group no longer exists' });
      const memberRows = rows.filter(r => r.status === 'member' && !(people.get(r.user_id) || {}).banned);
      const out = groupJson(g, { memberCount: memberRows.length, me, viewerId: userId, lang: req.lang, creatorName: (people.get(g.creator_id) || {}).name });
      if (isMember) {
        const person = r => ({ id: r.user_id, name: (people.get(r.user_id) || {}).name || '?', handicap: (people.get(r.user_id) || {}).handicap ?? null, photoUrl: photoOf(r.user_id), isCreator: r.user_id === g.creator_id });
        out.members = memberRows.map(person).sort((a, b) => (b.isCreator - a.isCreator) || a.name.localeCompare(b.name));
        if (out.isCreator) out.pending = rows.filter(r => r.status === 'pending').map(person);
        const { data: rounds, error } = await supabase.from('teetimes').select('*').eq('group_id', g.id).neq('status', 'cancelled').gte('date', todayish());
        if (error) throw error;
        const sorted = (rounds || []).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
        out.rounds = await Promise.all(sorted.map(async rd => ({
          ...(await buildTeetimeResponse(rd, userId)),
          groupId: g.id, groupName: g.name, openToAll: !!rd.open_to_all,
          canOpen: !rd.open_to_all && (rd.host_id === userId || out.isCreator),
        })));
      }
      res.json(out);
    }));

    // Invite link: what the group is (before joining), and joining.
    app.get('/api/groups/invite/:code', route(async (req, res, userId) => {
      const { data: g, error } = await supabase.from('groups').select('*').eq('invite_code', req.params.code).maybeSingle();
      if (error) throw error;
      if (!g || g.removed_at) return res.status(404).json({ error: 'This invite link no longer works' });
      res.json({ id: g.id });
    }));

    app.post('/api/groups/invite/:code/join', route(async (req, res, userId) => {
      const { data: g, error } = await supabase.from('groups').select('*').eq('invite_code', req.params.code).maybeSingle();
      if (error) throw error;
      if (!g || g.removed_at) return res.status(404).json({ error: 'This invite link no longer works' });
      if ((await getBlockedUserIds(userId)).has(g.creator_id) || demoMismatch(userId, g.creator_id)) return res.status(403).json({ error: 'You can’t join this group' });
      const me = await membershipOf(g.id, userId);
      if (me && me.status === 'member') return res.json({ id: g.id, joined: false });
      if (me) await supabase.from('group_members').update({ status: 'member' }).eq('group_id', g.id).eq('user_id', userId);
      else {
        const { error: insErr } = await supabase.from('group_members').insert({ group_id: g.id, user_id: userId, status: 'member', created_at: Date.now() });
        if (insErr && !/duplicate|unique/i.test(insErr.message)) throw insErr;
      }
      res.json({ id: g.id, joined: true });
    }, { write: true }));

    // Ask to join (no invite link): the creator approves.
    app.post('/api/groups/:id/request', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if ((await getBlockedUserIds(userId)).has(g.creator_id) || demoMismatch(userId, g.creator_id)) return res.status(403).json({ error: 'You can’t join this group' });
      const me = await membershipOf(g.id, userId);
      if (!me) {
        const { error } = await supabase.from('group_members').insert({ group_id: g.id, user_id: userId, status: 'pending', created_at: Date.now() });
        if (error && !/duplicate|unique/i.test(error.message)) throw error;
        const asker = await getUser(userId);
        notifyUser(g.creator_id, lang => lang === 'en'
          ? ['New group request', `${(asker && asker.name) || 'Someone'} wants to join ${g.name}`]
          : ['Nueva solicitud al grupo', `${(asker && asker.name) || 'Alguien'} quiere unirse a ${g.name}`],
        null, { data: { url: `foursomemobile://group/${encodeURIComponent(g.id)}` } }).catch(() => {});
      }
      res.json({ ok: true });
    }, { write: true }));

    // Withdraw a request, or leave the group. The creator can't leave (they
    // delete the group instead).
    app.post('/api/groups/:id/leave', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if (g.creator_id === userId) return res.status(400).json({ error: 'You created this group — delete it instead' });
      await supabase.from('group_members').delete().eq('group_id', g.id).eq('user_id', userId);
      res.json({ ok: true });
    }));

    // Creator: approve or deny someone asking to join, or remove a member.
    app.post('/api/groups/:id/members/:userId', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if (!creatorOnly(g, userId, res)) return;
      const target = req.params.userId;
      const action = req.body.action;
      if (target === g.creator_id) return res.status(400).json({ error: 'You can’t remove yourself' });
      const m = await membershipOf(g.id, target);
      if (!m) return res.status(404).json({ error: 'Request not found' });
      if (action === 'approve') {
        await supabase.from('group_members').update({ status: 'member' }).eq('group_id', g.id).eq('user_id', target);
        notifyUser(target, lang => lang === 'en'
          ? ["You're in!", `You're now a member of ${g.name}`]
          : ['¡Estás dentro!', `Ya sos parte de ${g.name}`],
        null, { data: { url: `foursomemobile://group/${encodeURIComponent(g.id)}` } }).catch(() => {});
      } else if (action === 'deny' || action === 'remove') {
        await supabase.from('group_members').delete().eq('group_id', g.id).eq('user_id', target);
      } else return res.status(400).json({ error: "action must be 'approve', 'deny' or 'remove'" });
      res.json({ ok: true });
    }, { write: true }));

    // A member's notification switch for this group.
    app.post('/api/groups/:id/notify', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if (!(await memberOnly(g, userId, res))) return;
      await supabase.from('group_members').update({ notify: !!req.body.on }).eq('group_id', g.id).eq('user_id', userId);
      res.json({ ok: true, notify: !!req.body.on });
    }));

    // Creator: the weekly round (on/off, day, time, spots).
    app.post('/api/groups/:id/weekly', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if (!creatorOnly(g, userId, res)) return;
      const enabled = !!req.body.enabled;
      const day = Number(req.body.day), spots = Number(req.body.spots), time = String(req.body.time || '');
      if (enabled && (!Number.isInteger(day) || day < 0 || day > 6 || !validTime(time) || !Number.isInteger(spots) || spots < 1 || spots > 4)) {
        return res.status(400).json({ error: 'Pick a day, a time and the number of spots' });
      }
      const changes = enabled
        ? { weekly_enabled: true, weekly_day: day, weekly_time: time, weekly_spots: spots }
        : { weekly_enabled: false };
      const { error } = await supabase.from('groups').update(changes).eq('id', g.id);
      if (error) throw error;
      if (enabled) await postWeeklyRounds();
      res.json({ ok: true });
    }, { write: true }));

    // Creator: delete the group.
    app.delete('/api/groups/:id', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if (!creatorOnly(g, userId, res)) return;
      await removeGroup(g);
      res.json({ ok: true });
    }));

    // Group chat (members only). Messages from people you blocked are left out.
    async function chatFor(groupId, viewerId) {
      const [{ data, error }, blocked] = await Promise.all([
        supabase.from('group_messages').select('*').eq('group_id', groupId).order('created_at', { ascending: true }),
        idsBlockedBy(viewerId),
      ]);
      if (error) throw error;
      return (data || []).sort((a, b) => Number(a.created_at) - Number(b.created_at)).slice(-300)
        .filter(m => !blocked.has(m.sender_id))
        .map(m => ({ id: m.id, senderId: m.sender_id, senderName: m.sender_name, text: m.text, createdAt: m.created_at, senderPhotoUrl: photoOf(m.sender_id) }));
    }

    app.get('/api/groups/:id/messages', route(async (req, res, userId) => {
      const g = await loadOr404(req, res); if (!g) return;
      if (!(await memberOnly(g, userId, res))) return;
      res.json(await chatFor(g.id, userId));
    }));

    app.post('/api/groups/:id/messages', route(async (req, res, userId) => {
      const text = String(req.body.text || '').trim().slice(0, 1000);
      if (!text) return res.status(400).json({ error: 'name and text are required' });
      const modError = moderateFields([text]);
      if (modError) return res.status(400).json(modError);
      const g = await loadOr404(req, res); if (!g) return;
      if (!(await memberOnly(g, userId, res))) return;
      const sender = await getUser(userId);
      const name = (sender && sender.name) || String(req.body.name || '').slice(0, 60) || '?';
      const { error } = await supabase.from('group_messages').insert({ group_id: g.id, sender_id: userId, sender_name: name, text, created_at: Date.now() });
      if (error) throw error;
      const preview = text.slice(0, 60);
      notifyMembers(g.id, userId, () => [`${name} · ${g.name}`, preview], `foursomemobile://group/${encodeURIComponent(g.id)}?chat=1`).catch(() => {});
      res.json(await chatFor(g.id, userId));
    }, { write: true }));

    // Host of a group round, or the group's creator: open the leftover spots
    // to everyone (Discover, and the usual new-round notifications).
    app.post('/api/teetimes/:id/open-to-all', route(async (req, res, userId) => {
      const { data: rd, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!rd || rd.status === 'cancelled') return res.status(404).json({ error: 'Not found' });
      if (!rd.group_id) return res.json({ ok: true });
      const g = await getGroup(rd.group_id);
      if (rd.host_id !== userId && !(g && g.creator_id === userId)) return res.status(403).json({ error: 'Only the host or the group’s creator can do that' });
      if (!rd.open_to_all) {
        const { error: uErr } = await supabase.from('teetimes').update({ open_to_all: true }).eq('id', rd.id);
        if (uErr) throw uErr;
        newRoundForEveryone({ ...rd, open_to_all: true });
      }
      res.json({ ok: true });
    }, { write: true }));

    // --- Owner ----------------------------------------------------------------
    app.post('/api/admin/groups/:id/remove', route(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const { data: g, error } = await supabase.from('groups').select('*').eq('id', req.params.id).maybeSingle();
      if (error) throw error;
      if (!g) return res.status(404).json({ error: 'This group no longer exists' });
      if (!g.removed_at) await removeGroup(g);
      // Close the open reports about it.
      await supabase.from('user_reports').update({ resolved_at: new Date().toISOString() })
        .eq('group_id', g.id).is('resolved_at', null).then(() => {}, () => {});
      res.json({ ok: true });
    }));
  }

  // For the owner's dashboard: live groups, newest first.
  async function dashboardList() {
    try {
      const { data: groups, error } = await supabase.from('groups').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const live = (groups || []).filter(g => !g.removed_at && !isDemo(g.creator_id));
      const { data: rows } = await supabase.from('group_members').select('group_id, status').in('group_id', live.map(g => g.id));
      const users = await namesOf([...new Set(live.map(g => g.creator_id))]);
      return live.slice(0, 50).map(g => ({
        id: g.id, name: g.name, course: g.home_course, creator: (users.get(g.creator_id) || {}).name || '?',
        members: (rows || []).filter(r => r.group_id === g.id && r.status === 'member').length,
      }));
    } catch (e) { return null; }
  }

  // For a report: the group being reported (name/description), or the
  // group chat message.
  async function reportTarget({ groupId, groupMessageId }, userId) {
    if (groupMessageId != null) {
      const { data: msg, error } = await supabase.from('group_messages').select('*').eq('id', groupMessageId).maybeSingle();
      if (error) throw error;
      if (!msg) return { status: 404, error: 'That message no longer exists' };
      const me = await membershipOf(msg.group_id, userId);
      if (!me || me.status !== 'member') return { status: 403, error: 'Not authorized for this chat' };
      return { reportedId: msg.sender_id, groupId: msg.group_id, groupMessageId: msg.id, text: String(msg.text).slice(0, 1000) };
    }
    const g = await getGroup(groupId);
    if (!g) return { status: 404, error: 'This group no longer exists' };
    return { reportedId: g.creator_id, groupId: g.id, text: `${g.name}${g.description ? ' — ' + g.description : ''}`.slice(0, 1000) };
  }

  async function groupNames(ids) {
    if (!ids.length) return new Map();
    const { data } = await supabase.from('groups').select('id, name, removed_at').in('id', ids);
    return new Map((data || []).map(g => [g.id, g]));
  }

  return {
    start, registerRoutes, visibility, roundVisible, roundGroupFields, canJoinRound, newGroupRound,
    membershipOf, deleteUserData, dashboardList, reportTarget, groupNames, postWeeklyRounds, removeGroup,
  };
}

module.exports = { makeGroups, nextWeeklyDate, localNow, tableMissing };
