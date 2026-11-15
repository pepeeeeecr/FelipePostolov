// "Did everyone show up?" — after a round's date, everyone who played (the
// host and each approved player) is asked once, and can answer "yes" or pick
// who didn't come. See supabase-notifications-attendance.sql.
//
// Reliability shown on profiles and join requests:
//   roundsPlayed  past rounds with at least one other player, minus the ones
//                 where the other players said this person didn't show
//   showUpRate    % of answered rounds this person showed up to; null until
//                 they've played 3 rounds (or nobody has answered yet)
// A no-show counts only when more than half of the other players who
// answered said so, so one person can't sink someone's rate alone.

const ASK_WITHIN_DAYS = 14;
const MIN_ROUNDS_FOR_RATE = 3;
const CACHE_MS = 5 * 60 * 1000;

// The round's local "today" is close enough with the server's date minus a
// day of slack: a round counts as past from the day after its date.
const yesterday = () => new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10);
const daysAgoDate = n => new Date(Date.now() - n * 24 * 3600e3).toISOString().slice(0, 10);

function participants(row) {
  return [row.host_id, ...(row.requests || []).filter(r => r.status === 'approved').map(r => r.userId)];
}

function registerAttendance(app, { supabase, ah, verifiedUserId, DEMO_USER_IDS }) {
  let cache = null; // { at, stats: Map }
  let missingWarned = false;
  const tableMissing = e => e && /round_attendance|does not exist|schema cache/i.test(e.message || '');

  async function computeAll() {
    const { data: rounds, error } = await supabase.from('teetimes').select('id, host_id, host_name, requests, date, status')
      .neq('status', 'cancelled').lte('date', yesterday());
    if (error) throw error;
    const { data: answers, error: aErr } = await supabase.from('round_attendance').select('teetime_id, reporter_id, no_show_ids');
    if (aErr) throw aErr;
    const byRound = new Map();
    for (const a of answers || []) {
      if (!byRound.has(a.teetime_id)) byRound.set(a.teetime_id, []);
      byRound.get(a.teetime_id).push(a);
    }
    const stats = new Map();
    const get = id => { if (!stats.has(id)) stats.set(id, { played: 0, answered: 0, showed: 0 }); return stats.get(id); };
    for (const rd of rounds || []) {
      const people = participants(rd);
      if (people.length < 2) continue;
      const roundAnswers = byRound.get(rd.id) || [];
      for (const uid of people) {
        const s = get(uid);
        const others = roundAnswers.filter(a => a.reporter_id !== uid);
        const saidNo = others.filter(a => (a.no_show_ids || []).includes(uid)).length;
        const noShow = others.length > 0 && saidNo * 2 > others.length;
        if (!noShow) s.played += 1;
        if (others.length > 0) { s.answered += 1; if (!noShow) s.showed += 1; }
      }
    }
    return stats;
  }

  // userIds -> Map(userId -> { roundsPlayed, showUpRate })
  async function reliabilityFor(userIds) {
    const out = new Map();
    try {
      if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), stats: await computeAll() };
    } catch (e) {
      if (tableMissing(e)) {
        if (!missingWarned) console.warn('Show-up stats are off until supabase-notifications-attendance.sql is run.');
        missingWarned = true;
      } else console.error('Show-up stats failed:', e.message);
      return out;
    }
    for (const id of userIds) {
      const s = cache.stats.get(id) || { played: 0, answered: 0, showed: 0 };
      out.set(id, {
        roundsPlayed: s.played,
        showUpRate: s.played >= MIN_ROUNDS_FOR_RATE && s.answered > 0 ? Math.round((100 * s.showed) / s.answered) : null,
      });
    }
    return out;
  }

  // Rounds this person played that they haven't answered about yet.
  app.get('/api/attendance/pending', ah(async (req, res) => {
    const userId = verifiedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Sign in required' });
    const { data: rounds, error } = await supabase.from('teetimes').select('*')
      .neq('status', 'cancelled').lte('date', yesterday()).gte('date', daysAgoDate(ASK_WITHIN_DAYS));
    if (error) return res.status(500).json({ error: 'Could not load rounds' });
    const mine = (rounds || []).filter(rd => participants(rd).includes(userId) && participants(rd).length >= 2);
    if (!mine.length) return res.json({ rounds: [] });
    const { data: answered, error: aErr } = await supabase.from('round_attendance').select('teetime_id')
      .eq('reporter_id', userId).in('teetime_id', mine.map(r => r.id));
    if (aErr) return res.json({ rounds: [] }); // table not there yet: nothing to ask
    const done = new Set((answered || []).map(a => a.teetime_id));
    res.json({
      rounds: mine.filter(rd => !done.has(rd.id) && !DEMO_USER_IDS.has(rd.host_id)).map(rd => ({
        id: rd.id, course: rd.course, date: rd.date, time: rd.time,
        players: [
          { id: rd.host_id, name: rd.host_name },
          ...(rd.requests || []).filter(r => r.status === 'approved').map(r => ({ id: r.userId, name: r.name })),
        ].filter(p => p.id !== userId),
      })),
    });
  }));

  // { noShowIds: [] } means everyone showed up.
  app.post('/api/teetimes/:id/attendance', ah(async (req, res) => {
    const userId = verifiedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Sign in required' });
    const { data: rd, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: 'Could not load tee time' });
    if (!rd) return res.status(404).json({ error: 'Not found' });
    const people = participants(rd);
    if (!people.includes(userId)) return res.status(403).json({ error: 'Only players in this round can answer' });
    if (rd.status === 'cancelled' || rd.date > yesterday()) return res.status(400).json({ error: 'This round hasn’t happened yet' });
    const ids = Array.isArray(req.body.noShowIds) ? [...new Set(req.body.noShowIds.map(String))] : [];
    if (ids.some(id => id === userId || !people.includes(id))) return res.status(400).json({ error: 'Pick players from this round' });
    const { error: insErr } = await supabase.from('round_attendance').insert({ teetime_id: rd.id, reporter_id: userId, no_show_ids: ids });
    if (insErr && !/duplicate|unique/i.test(insErr.message)) {
      console.error('Attendance save failed:', insErr.message);
      return res.status(500).json({ error: 'Could not save your answer' });
    }
    cache = null;
    res.json({ ok: true });
  }));

  return { reliabilityFor };
}

module.exports = { registerAttendance };
