// Friends (see supabase-friends.sql).
//
// - You can add someone as a friend once you've played with them: a past
//   round you were both in (host or approved player), or a past event you
//   both paid for. They accept or decline.
// - Blocked people (either direction) can't be friends: blocking removes
//   the friendship and any request, and they're left out of every list.
// - When posting a round you can invite friends: they get a notification,
//   and can see and join the round even if it's a members-only group round.

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://felipepostolov.onrender.com';
const NOT_READY = 'Friends aren’t set up yet';
const MAX_INVITES = 20;
const tableMissing = e => !!e && /friendship|invited_ids|does not exist|schema cache|relation/i.test(e.message || '');
const pair = (x, y) => (x < y ? { user_a: x, user_b: y } : { user_a: y, user_b: x });
const other = (row, me) => (row.user_a === me ? row.user_b : row.user_a);

function makeFriends(deps) {
  const { supabase, photoOf, getUser, getBlockedUserIds, getBannedUserIds, notifyUser } = deps;
  let warned = false;
  const warn = e => { if (!warned) console.warn('Friends are off until supabase-friends.sql is run:', e.message); warned = true; };
  const yesterday = () => new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10);

  async function rowsFor(userId) {
    const [a, b] = await Promise.all([
      supabase.from('friendships').select('*').eq('user_a', userId),
      supabase.from('friendships').select('*').eq('user_b', userId),
    ]);
    if (a.error) throw a.error;
    if (b.error) throw b.error;
    return [...(a.data || []), ...(b.data || [])];
  }

  async function rowBetween(x, y) {
    const p = pair(x, y);
    const { data, error } = await supabase.from('friendships').select('*').eq('user_a', p.user_a).eq('user_b', p.user_b).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  // Everyone this person has played with: past rounds (host + approved
  // players) and past events they both paid for.
  async function playedWith(userId) {
    const out = new Set();
    const { data: rounds } = await supabase.from('teetimes').select('host_id, requests, date, status').neq('status', 'cancelled').lte('date', yesterday());
    for (const rd of rounds || []) {
      const people = [rd.host_id, ...(rd.requests || []).filter(r => r.status === 'approved').map(r => r.userId)];
      if (people.includes(userId)) people.forEach(p => out.add(p));
    }
    const { data: mine } = await supabase.from('event_registrations').select('event_id, status').eq('user_id', userId).eq('status', 'confirmed');
    const eventIds = (mine || []).map(r => r.event_id);
    if (eventIds.length) {
      const { data: events } = await supabase.from('events').select('id, starts_at').in('id', eventIds);
      const past = (events || []).filter(e => new Date(e.starts_at) <= new Date()).map(e => e.id);
      if (past.length) {
        const { data: regs } = await supabase.from('event_registrations').select('user_id, status').in('event_id', past).eq('status', 'confirmed');
        (regs || []).forEach(r => out.add(r.user_id));
      }
    }
    out.delete(userId);
    return out;
  }

  // Accepted friends' ids (minus anyone blocked either way).
  async function friendIds(userId) {
    const [rows, blocked] = await Promise.all([rowsFor(userId), getBlockedUserIds(userId)]);
    return new Set(rows.filter(r => r.status === 'accepted').map(r => other(r, userId)).filter(id => !blocked.has(id)));
  }

  // For a profile: 'friends' | 'requested' (I asked) | 'incoming' (they
  // asked) | 'can_add' (we've played together) | null (none of these).
  async function statusBetween(me, them) {
    try {
      if ((await getBlockedUserIds(me)).has(them)) return null;
      const row = await rowBetween(me, them);
      if (row && row.status === 'accepted') return 'friends';
      if (row) return row.requester_id === me ? 'requested' : 'incoming';
      return (await playedWith(me)).has(them) ? 'can_add' : null;
    } catch (e) {
      if (tableMissing(e)) warn(e); else console.error('Friend status failed:', e.message);
      return null;
    }
  }

  async function people(ids) {
    if (!ids.length) return [];
    const { data } = await supabase.from('users').select('user_id, name, handicap, home_course, banned').in('user_id', ids);
    return (data || []).filter(u => !u.banned)
      .map(u => ({ id: u.user_id, name: u.name, handicap: u.handicap, homeCourse: u.home_course, photoUrl: photoOf(u.user_id) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // Blocking ends a friendship (and any request), both directions.
  async function onBlock(x, y) {
    const p = pair(x, y);
    await supabase.from('friendships').delete().eq('user_a', p.user_a).eq('user_b', p.user_b).then(() => {}, () => {});
  }

  async function deleteUserData(userId) {
    try {
      const a = await supabase.from('friendships').delete().eq('user_a', userId);
      if (a.error) throw a.error;
      const b = await supabase.from('friendships').delete().eq('user_b', userId);
      if (b.error) throw b.error;
    } catch (e) { if (!tableMissing(e)) throw e; }
  }

  // Inviting friends to a new round: keeps only real friends, tells them.
  async function inviteToRound(row, hostName, ids) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_INVITES);
    if (!wanted.length) return [];
    const friends = await friendIds(row.host_id);
    const invited = wanted.filter(id => friends.has(id));
    if (!invited.length) return [];
    const { error } = await supabase.from('teetimes').update({ invited_ids: invited }).eq('id', row.id);
    if (error) throw error;
    for (const id of invited) {
      notifyUser(id, lang => lang === 'en'
        ? [`${hostName} invited you to a round`, `${row.course} · ${row.date} · ${row.time}`]
        : [`${hostName} te invitó a una ronda`, `${row.course} · ${row.date} · ${row.time}`],
      null, { data: { url: `${PUBLIC_URL}/r/${encodeURIComponent(row.id)}` } }).catch(() => {});
    }
    return invited;
  }

  const isInvited = (row, userId) => !!userId && (row.invited_ids || []).includes(userId);

  function registerRoutes(app, { ah, verifiedUserId, isBanned, BANNED_ERROR }) {
    const route = fn => ah(async (req, res) => {
      const userId = verifiedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Sign in required' });
      try { await fn(req, res, userId); } catch (e) {
        if (tableMissing(e)) { warn(e); return res.status(503).json({ error: NOT_READY }); }
        throw e;
      }
    });

    // Friends, requests both ways, and people you've played with.
    app.get('/api/friends', route(async (req, res, userId) => {
      const [rows, blocked, banned, played] = await Promise.all([
        rowsFor(userId), getBlockedUserIds(userId), getBannedUserIds(), playedWith(userId),
      ]);
      const ok = id => !blocked.has(id) && !banned.has(id);
      const friends = rows.filter(r => r.status === 'accepted').map(r => other(r, userId)).filter(ok);
      const incoming = rows.filter(r => r.status === 'pending' && r.requester_id !== userId).map(r => other(r, userId)).filter(ok);
      const outgoing = rows.filter(r => r.status === 'pending' && r.requester_id === userId).map(r => other(r, userId)).filter(ok);
      const known = new Set([...friends, ...incoming, ...outgoing]);
      const suggestions = [...played].filter(id => ok(id) && !known.has(id));
      const [f, i, o, s] = await Promise.all([people(friends), people(incoming), people(outgoing), people(suggestions)]);
      res.json({ friends: f, incoming: i, outgoing: o, suggestions: s.slice(0, 30) });
    }));

    // action: 'add' (ask, or accept if they already asked), 'accept',
    // 'decline', 'remove' (unfriend, or cancel my request).
    app.post('/api/friends/:userId', route(async (req, res, userId) => {
      const them = String(req.params.userId);
      const action = req.body.action;
      if (them === userId) return res.status(400).json({ error: 'That’s you' });
      const row = await rowBetween(userId, them);
      if (action === 'remove' || action === 'decline') {
        if (row) {
          const p = pair(userId, them);
          await supabase.from('friendships').delete().eq('user_a', p.user_a).eq('user_b', p.user_b);
        }
        return res.json({ ok: true, status: null });
      }
      if (action !== 'add' && action !== 'accept') return res.status(400).json({ error: "action must be 'add', 'accept', 'decline' or 'remove'" });
      if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
      if ((await getBlockedUserIds(userId)).has(them)) return res.status(403).json({ error: 'You can’t add this person as a friend' });
      const me = await getUser(userId);
      const myName = (me && me.name) || '';
      if (row && row.status === 'accepted') return res.json({ ok: true, status: 'friends' });
      if (row && row.requester_id !== userId) {
        // They asked first: accept.
        await supabase.from('friendships').update({ status: 'accepted' }).eq('id', row.id);
        notifyUser(them, lang => lang === 'en'
          ? ['New friend', `${myName} accepted your friend request`]
          : ['Nueva amistad', `${myName} aceptó tu solicitud de amistad`],
        null, { data: { url: 'foursomemobile://friends' } }).catch(() => {});
        return res.json({ ok: true, status: 'friends' });
      }
      if (row) return res.json({ ok: true, status: 'requested' });
      if (action === 'accept') return res.status(404).json({ error: 'Request not found' });
      if (!(await playedWith(userId)).has(them)) return res.status(403).json({ error: 'You can add people as friends after playing a round or an event together' });
      const { error } = await supabase.from('friendships').insert({ ...pair(userId, them), requester_id: userId, status: 'pending', created_at: Date.now() });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
      notifyUser(them, lang => lang === 'en'
        ? ['Friend request', `${myName} wants to add you as a friend`]
        : ['Solicitud de amistad', `${myName} quiere agregarte como amigo`],
      null, { data: { url: 'foursomemobile://friends' } }).catch(() => {});
      res.json({ ok: true, status: 'requested' });
    }));
  }

  return { registerRoutes, statusBetween, friendIds, inviteToRound, isInvited, onBlock, deleteUserData, playedWith };
}

module.exports = { makeFriends };
