// Notifications about rounds and events (see supabase-notifications-attendance.sql):
//
//   new_round      a round is posted at your home course
//   new_event      an event is created within 100 km of your home course
//   event_3days    3 days before an event you haven't joined
//   event_spots    an event you haven't joined is down to 3 or fewer spots
//   reminder_round / reminder_event
//                  the evening before a round or event you're in
//
// The first four obey the Settings switches (round / event notifications),
// are never sent to whoever created the round or event, and are capped at 2
// per person per 24 hours. Reminders are about plans you made, so they
// always go out. Every notification is logged once per person and round or
// event (notification_log), so nothing is sent twice.
//
// Users are matched by their home course only — the app doesn't store
// anyone's location. A home course's coordinates are looked up once and
// kept (course_search_cache, key 'home:<name>').

const KM_PER_MILE = 1.609344;
const ROUND_SAME_COURSE_KM = 0.5;
const EVENT_RADIUS_KM = 100;
const DAILY_CAP = 2;
const CAPPED = ['new_round', 'new_event', 'event_3days', 'event_spots'];
const CHECK_EVERY_MS = 10 * 60 * 1000;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://felipepostolov.onrender.com';

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const colones = n => '₡' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function makeNotifier(deps) {
  const { supabase, notifyUser, geocodeCourse, haversineMiles, DEMO_USER_IDS } = deps;
  const km = (a, b) => haversineMiles(a.lat, a.lng, b.lat, b.lng) * KM_PER_MILE;
  let disabledWarned = false;
  const homeCoords = new Map();   // folded name -> { lat, lng } | null

  const tableMissing = error => error && /notification_log|round_attendance|does not exist|schema cache/i.test(error.message || '');
  function warnDisabled(error) {
    if (!disabledWarned) console.warn('Round/event notifications are off until supabase-notifications-attendance.sql is run:', error.message);
    disabledWarned = true;
  }

  // --- Home courses ----------------------------------------------------------
  async function coordsForHome(name) {
    const key = fold(name);
    if (!key) return null;
    if (homeCoords.has(key)) return homeCoords.get(key);
    const { data: saved } = await supabase.from('course_search_cache').select('data').eq('key', `home:${key}`).maybeSingle();
    if (saved) { homeCoords.set(key, saved.data && saved.data.lat != null ? saved.data : null); return homeCoords.get(key); }
    const geo = await geocodeCourse(name).catch(() => null);
    const value = geo ? { lat: geo.lat, lng: geo.lng } : null;
    homeCoords.set(key, value);
    await supabase.from('course_search_cache').upsert({ key: `home:${key}`, data: value || { none: true }, complete: true, updated_at: new Date().toISOString() });
    return value;
  }

  // Without waiting: the coordinates if already known (null when the
  // course can't be found), undefined while they're being looked up in the
  // background for next time.
  const peeking = new Set();
  function peekHome(name) {
    const key = fold(name);
    if (!key) return null;
    if (homeCoords.has(key)) return homeCoords.get(key);
    if (!peeking.has(key)) {
      peeking.add(key);
      coordsForHome(name).catch(() => {}).finally(() => peeking.delete(key));
    }
    return undefined;
  }

  // Everyone who could be told, with their home course (and its coordinates
  // when `withCoords`). Banned and demo accounts are left out.
  async function candidates(withCoords) {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    const people = (data || []).filter(u => u.home_course && !u.banned && !DEMO_USER_IDS.has(u.user_id));
    if (withCoords) {
      for (const u of people) u.home = await coordsForHome(u.home_course);
    }
    return people;
  }

  async function blockedWith(userId) {
    const { data } = await supabase.from('blocks').select('blocker_id, blocked_id').or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    return new Set((data || []).map(b => (b.blocker_id === userId ? b.blocked_id : b.blocker_id)));
  }

  // --- Sending ---------------------------------------------------------------
  async function sentToday(userId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase.from('notification_log').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).in('kind', CAPPED).gte('sent_at', since);
    if (error) throw error;
    return count || 0;
  }

  // Logs first (the unique key stops a second send), then sends. Returns
  // true when something went out.
  async function sendOnce(userId, kind, refId, message, { pref, url } = {}) {
    // Settings switches are stored with each phone's push registration; a
    // person with none that would show this isn't logged or counted.
    const accept = sub => !pref || !(sub && sub.prefs && sub.prefs[pref] === false);
    const { data: subs } = await supabase.from('push_subscriptions').select('subscription').eq('user_id', userId);
    if (!(subs || []).some(r => accept(r.subscription))) return false;
    if (CAPPED.includes(kind) && (await sentToday(userId)) >= DAILY_CAP) return false;
    const { error } = await supabase.from('notification_log').insert({ user_id: userId, kind, ref_id: String(refId) });
    if (error) {
      if (tableMissing(error)) { warnDisabled(error); throw error; }
      return false; // already sent (unique key)
    }
    await notifyUser(userId, message, null, { data: url ? { url } : undefined, accept });
    return true;
  }

  // --- Text ------------------------------------------------------------------
  function shortWhen(date, tz, lang) {
    const soon = date - Date.now() < 6 * 24 * 60 * 60 * 1000;
    const s = new Intl.DateTimeFormat(lang === 'es' ? 'es-CR' : 'en-US', {
      timeZone: tz || 'America/Costa_Rica', weekday: 'long', ...(soon ? {} : { day: 'numeric', month: 'short' }),
      hour: 'numeric', minute: '2-digit',
    }).format(date).replace(/,(?=[^,]*$)/, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function distanceText(kmValue, unit) {
    const v = unit === 'mi' ? kmValue / KM_PER_MILE : kmValue;
    return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${unit === 'mi' ? 'mi' : 'km'}`;
  }
  const unitOf = sub => (sub && sub.prefs && sub.prefs.unit === 'mi' ? 'mi' : 'km');

  // --- New round ---------------------------------------------------------------
  async function newRound(row) {
    try {
      const people = await candidates(row.lat != null);
      const blocked = await blockedWith(row.host_id);
      const here = row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null;
      for (const u of people) {
        if (u.user_id === row.host_id || blocked.has(u.user_id)) continue;
        const sameName = fold(u.home_course) === fold(row.course);
        const sameSpot = here && u.home && km(here, u.home) <= ROUND_SAME_COURSE_KM;
        if (!sameName && !sameSpot) continue;
        await sendOnce(u.user_id, 'new_round', row.id, lang => lang === 'en'
          ? [`New round at ${row.course}`, `${row.date} · ${row.time} · ${row.open_spots} spot${row.open_spots === 1 ? '' : 's'} open`]
          : [`Ronda nueva en ${row.course}`, `${row.date} · ${row.time} · ${row.open_spots} espacio${row.open_spots === 1 ? '' : 's'} libre${row.open_spots === 1 ? '' : 's'}`],
          { pref: 'rounds', url: `${PUBLIC_URL}/r/${encodeURIComponent(row.id)}` });
      }
    } catch (e) {
      if (!tableMissing(e)) console.error('New round notifications failed:', e.message);
    }
  }

  // --- Events --------------------------------------------------------------------
  // People within 100 km of the event by home course (or whose home course
  // is the event's course), minus the creator, anyone blocked with them,
  // and anyone with a registration (paid, holding or refunded).
  async function eventAudience(ev) {
    const people = await candidates(true);
    const blocked = ev.created_by ? await blockedWith(ev.created_by) : new Set();
    const { data: regs } = await supabase.from('event_registrations').select('user_id').eq('event_id', ev.id);
    const joined = new Set((regs || []).map(r => r.user_id));
    const here = ev.lat != null && ev.lng != null ? { lat: ev.lat, lng: ev.lng } : null;
    const out = [];
    for (const u of people) {
      if (u.user_id === ev.created_by || blocked.has(u.user_id) || joined.has(u.user_id)) continue;
      const sameName = fold(u.home_course) === fold(ev.course);
      const d = here && u.home ? km(here, u.home) : null;
      if (sameName || (d != null && d <= EVENT_RADIUS_KM)) out.push({ userId: u.user_id, km: sameName ? 0 : d });
    }
    return out;
  }

  async function eventMessage(ev, who, kind, spotsLeft) {
    const start = new Date(ev.starts_at);
    const url = `${PUBLIC_URL}/e/${ev.id}`;
    // The distance needs the person's unit, which comes with each phone's
    // push registration — so the text is built per subscription.
    const text = (lang, unit) => {
      const when = shortWhen(start, ev.time_zone, lang);
      const price = colones(ev.price_colones);
      const far = who.km != null && who.km >= 1 ? distanceText(who.km, unit) : null;
      if (kind === 'new_event') {
        return lang === 'en'
          ? [ev.title, `New event at ${ev.course}${far ? `, ${far} away` : ''}: ${when}, ${price}`]
          : [ev.title, `Evento nuevo en ${ev.course}${far ? `, a ${far}` : ''}: ${when}, ${price}`];
      }
      if (kind === 'event_3days') {
        return lang === 'en'
          ? [`In 3 days: ${ev.title}`, `${ev.course}${far ? ` (${far} away)` : ''}, ${when}, ${price}. ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left.`]
          : [`En 3 días: ${ev.title}`, `${ev.course}${far ? ` (a ${far})` : ''}, ${when}, ${price}. Quedan ${spotsLeft} espacio${spotsLeft === 1 ? '' : 's'}.`];
      }
      return lang === 'en'
        ? [`${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left: ${ev.title}`, `${ev.course}${far ? ` (${far} away)` : ''}, ${when}, ${price}`]
        : [`Queda${spotsLeft === 1 ? '' : 'n'} ${spotsLeft} espacio${spotsLeft === 1 ? '' : 's'}: ${ev.title}`, `${ev.course}${far ? ` (a ${far})` : ''}, ${when}, ${price}`];
    };
    return { text, url };
  }

  async function sendEvent(ev, kind, spotsLeft) {
    for (const who of await eventAudience(ev)) {
      const { text, url } = await eventMessage(ev, who, kind, spotsLeft);
      await sendOnce(who.userId, kind, ev.id, (lang, sub) => text(lang, unitOf(sub)), { pref: 'events', url });
    }
  }

  async function newEvent(ev) {
    try {
      if (ev.status !== 'open' || new Date(ev.starts_at) <= new Date()) return;
      await sendEvent(ev, 'new_event');
    } catch (e) {
      if (!tableMissing(e)) console.error('New event notifications failed:', e.message);
    }
  }

  // --- Every 10 minutes: event follow-ups and evening-before reminders -----------
  const ACTIVE_HOLD = r => r.status === 'held' && r.hold_expires_at && new Date(r.hold_expires_at) > new Date();

  async function eventFollowUps() {
    const now = Date.now();
    const { data: events, error } = await supabase.from('events').select('*').eq('status', 'open')
      .gt('starts_at', new Date(now).toISOString()).lt('starts_at', new Date(now + 31 * 24 * 3600e3).toISOString());
    if (error) throw error;
    for (const ev of events || []) {
      const { data: regs } = await supabase.from('event_registrations').select('*').eq('event_id', ev.id);
      const taken = (regs || []).filter(r => r.status === 'confirmed' || ACTIVE_HOLD(r)).reduce((n, r) => n + Math.max(1, Number(r.spots) || 1), 0);
      const spotsLeft = Math.max(0, ev.max_players - taken);
      if (spotsLeft === 0) continue;
      const untilStart = new Date(ev.starts_at).getTime() - now;
      if (untilStart <= 3 * 24 * 3600e3 && untilStart > 2 * 24 * 3600e3) await sendEvent(ev, 'event_3days', spotsLeft);
      if (spotsLeft <= 3) await sendEvent(ev, 'event_spots', spotsLeft);
    }
  }

  // Local hour and date at a place. Rounds don't store a time zone, so it's
  // estimated from the course's longitude (15° per hour) — close enough to
  // tell evening from morning — and Costa Rica's when the course has no
  // location. Events have their real time zone.
  function localParts(tz, lng, at = new Date()) {
    if (tz) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(at).map(x => [x.type, x.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
    }
    const offsetH = lng != null ? Math.round(lng / 15) : -6;
    const local = new Date(at.getTime() + offsetH * 3600e3);
    return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
  }
  const nextDay = d => new Date(new Date(d + 'T12:00:00Z').getTime() + 24 * 3600e3).toISOString().slice(0, 10);
  const isEvening = h => h >= 18 && h < 22;

  async function eveningReminders() {
    // Rounds tomorrow (local), for the host and approved players.
    const today = new Date().toISOString().slice(0, 10);
    const { data: rounds, error } = await supabase.from('teetimes').select('*').neq('status', 'cancelled')
      .gte('date', today).lte('date', nextDay(nextDay(today)));
    if (error) throw error;
    for (const rd of rounds || []) {
      const here = localParts(null, rd.lng);
      if (!isEvening(here.hour) || rd.date !== nextDay(here.date)) continue;
      const people = [rd.host_id, ...(rd.requests || []).filter(r => r.status === 'approved').map(r => r.userId)];
      if (people.length < 2) continue; // nobody joined: nothing to remind about
      for (const userId of people) {
        await sendOnce(userId, 'reminder_round', rd.id, lang => lang === 'en'
          ? [`Tomorrow: ${rd.course}`, `Tee time ${rd.time}. Tap to see the round.`]
          : [`Mañana: ${rd.course}`, `Salida a las ${rd.time}. Tocá para ver la ronda.`],
          { url: `${PUBLIC_URL}/r/${encodeURIComponent(rd.id)}` });
      }
    }
    // Events tomorrow (in the event's time zone), for everyone confirmed.
    const { data: events } = await supabase.from('events').select('*').eq('status', 'open')
      .gt('starts_at', new Date().toISOString()).lt('starts_at', new Date(Date.now() + 2 * 24 * 3600e3).toISOString());
    for (const ev of events || []) {
      const here = localParts(ev.time_zone);
      const evDay = localParts(ev.time_zone, null, new Date(ev.starts_at)).date;
      if (!isEvening(here.hour) || evDay !== nextDay(here.date)) continue;
      const { data: regs } = await supabase.from('event_registrations').select('user_id').eq('event_id', ev.id).eq('status', 'confirmed');
      for (const r of regs || []) {
        await sendOnce(r.user_id, 'reminder_event', ev.id, lang => {
          const time = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'es-CR', { timeZone: ev.time_zone, hour: 'numeric', minute: '2-digit' }).format(new Date(ev.starts_at));
          return lang === 'en'
            ? [`Tomorrow: ${ev.title}`, `${ev.course} at ${time}. Tap to see the event.`]
            : [`Mañana: ${ev.title}`, `${ev.course} a las ${time}. Tocá para ver el evento.`];
        }, { url: `${PUBLIC_URL}/e/${ev.id}` });
      }
    }
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await eventFollowUps();
      await eveningReminders();
    } catch (e) {
      if (tableMissing(e)) warnDisabled(e); else console.error('Scheduled notifications failed:', e.message);
    } finally {
      running = false;
    }
  }

  function start() {
    setTimeout(tick, 60 * 1000).unref();
    setInterval(tick, CHECK_EVERY_MS).unref();
  }

  return { start, newRound, newEvent, tick, peekHome, coordsForHome, _internals: { localParts, shortWhen, distanceText, nextDay, fold } };
}

module.exports = { makeNotifier };
