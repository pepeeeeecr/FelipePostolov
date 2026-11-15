// "What's happening nearby" — the short line at the top of Discover:
//   golfers whose home course is within 100 km, open rounds this week
//   within 100 km, and the next event (nearest in time, within 100 km).
//
// Measured from the phone's location when the app sends it (used for this
// answer only, never stored), otherwise from the person's home course.
// Any count below 5 is sent as null, so the app never shows "2 golfers"
// and small numbers don't reveal who's around. Answers are cached for 5
// minutes per area.

const RADIUS_KM = 100;
const MIN_SHOWN = 5;
const CACHE_MS = 5 * 60 * 1000;
const KM_PER_MILE = 1.609344;

function registerActivity(app, { supabase, ah, verifiedUserId, haversineMiles, peekHome, DEMO_USER_IDS, whenLabel }) {
  const cache = new Map(); // area key -> { at, data }
  const km = (a, b) => haversineMiles(a.lat, a.lng, b.lat, b.lng) * KM_PER_MILE;
  const shown = n => (n >= MIN_SHOWN ? n : null);
  const isoDay = d => d.toISOString().slice(0, 10);

  async function compute(origin, viewerId, lang) {
    // Golfers: everyone (but you) whose home course is within 100 km.
    const { data: users } = await supabase.from('users').select('*');
    let golfers = 0;
    for (const u of users || []) {
      if (u.user_id === viewerId || u.banned || DEMO_USER_IDS.has(u.user_id) || !u.home_course) continue;
      const home = peekHome(u.home_course);
      if (home && km(origin, home) <= RADIUS_KM) golfers++;
    }

    // Open rounds in the next 7 days within 100 km (by the round's own
    // location, or its course's).
    const today = new Date();
    const { data: rounds } = await supabase.from('teetimes').select('*')
      .neq('status', 'cancelled').gt('open_spots', 0).gte('date', isoDay(new Date(today.getTime() - 24 * 3600e3)))
      .lte('date', isoDay(new Date(today.getTime() + 7 * 24 * 3600e3)));
    let openRounds = 0;
    for (const rd of rounds || []) {
      if (DEMO_USER_IDS.has(rd.host_id)) continue;
      if (rd.group_id && !rd.open_to_all) continue; // members-only group round
      const at = rd.lat != null && rd.lng != null ? { lat: rd.lat, lng: rd.lng } : peekHome(rd.course);
      if (at && km(origin, at) <= RADIUS_KM) openRounds++;
    }

    // The next open event within 100 km.
    const { data: events } = await supabase.from('events').select('id, title, course, lat, lng, starts_at, time_zone')
      .eq('status', 'open').gt('starts_at', new Date().toISOString()).order('starts_at', { ascending: true }).limit(50);
    const next = (events || []).find(ev => {
      const at = ev.lat != null && ev.lng != null ? { lat: ev.lat, lng: ev.lng } : peekHome(ev.course);
      return at && km(origin, at) <= RADIUS_KM;
    });

    return {
      golfers: shown(golfers),
      openRoundsThisWeek: shown(openRounds),
      nextEvent: next ? { id: next.id, title: next.title, course: next.course, whenLabel: whenLabel(new Date(next.starts_at), next.time_zone, lang) } : null,
    };
  }

  app.get('/api/activity', ah(async (req, res) => {
    const viewerId = verifiedUserId(req);
    let origin = null;
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) origin = { lat, lng };
    if (!origin && viewerId) {
      const { data: me } = await supabase.from('users').select('home_course').eq('user_id', viewerId).maybeSingle();
      const home = me && me.home_course ? peekHome(me.home_course) : null;
      if (home) origin = home;
    }
    if (!origin) return res.json({ golfers: null, openRoundsThisWeek: null, nextEvent: null });

    // ~10 km areas, so nearby people share one answer.
    const key = `${req.lang}:${origin.lat.toFixed(1)}:${origin.lng.toFixed(1)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    const data = await compute(origin, viewerId, req.lang);
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    res.json(data);
  }));
}

module.exports = { registerActivity };
