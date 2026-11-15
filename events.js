// Paid events: listing, the owner-only admin routes, and "Request an event".
// Prices are whole colones (CRC). Payment, holds and refunds are in
// eventPayments.js (see supabase-events.sql and supabase-event-payments.sql).

// Only these signed-in accounts (with a confirmed email) can create, edit
// and cancel events. Set EVENT_ADMIN_EMAILS on the server (comma-separated)
// to change it without a code change.
const places = require('./places');

const EVENT_ADMIN_EMAILS = new Set(
  (process.env.EVENT_ADMIN_EMAILS || 'foursomeapp.golf@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

function isEventAdmin(req) {
  const u = req.authUser;
  return !!(u && u.email && u.email_confirmed_at && EVENT_ADMIN_EMAILS.has(u.email.toLowerCase()));
}

// --- Time zones -------------------------------------------------------------
// Events are entered as a local date and time at the course plus its IANA
// time zone, stored as an exact instant (starts_at), and shown back in the
// course's own time — so a 8:00 AM tee time reads 8:00 AM wherever you are.

function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

function zoneOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - date.getTime();
}

// 'YYYY-MM-DD' + 'HH:MM' at the course → the exact instant.
function localToInstant(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - zoneOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return { localDate: `${get('year')}-${get('month')}-${get('day')}`, localTime: `${get('hour')}:${get('minute')}` };
}

// lang 'es' gives Costa Rican Spanish, e.g. "sáb, 22 nov, 8:00 a. m. CST".
function whenLabel(date, tz, lang = 'en') {
  return new Intl.DateTimeFormat(lang === 'es' ? 'es-CR' : 'en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

// --- Shapes -------------------------------------------------------------------

const ACTIVE_HOLD = r => r.status === 'held' && r.hold_expires_at && new Date(r.hold_expires_at) > new Date();

function eventJson(row, regs, { haversineMiles, lat, lng, lang = 'en' } = {}) {
  const start = new Date(row.starts_at);
  const confirmed = regs.filter(r => r.status === 'confirmed');
  const held = regs.filter(ACTIVE_HOLD);
  const json = {
    id: row.id,
    title: row.title,
    course: row.course,
    lat: row.lat,
    lng: row.lng,
    startsAt: start.toISOString(),
    timeZone: row.time_zone,
    whenLabel: whenLabel(start, row.time_zone, lang),
    ...localParts(start, row.time_zone),
    priceColones: row.price_colones,
    currency: 'crc',
    maxPlayers: row.max_players,
    description: row.description || '',
    cancelCutoffHours: row.cancel_cutoff_hours,
    status: row.status,
    isPast: start <= new Date(),
    goingCount: confirmed.length,
    spotsLeft: Math.max(0, row.max_players - confirmed.length - held.length),
    ...places.fields(row.lat, row.lng, lang),
  };
  if (haversineMiles && lat != null && lng != null && row.lat != null && row.lng != null) {
    json.distanceMiles = Math.round(haversineMiles(lat, lng, row.lat, row.lng) * 10) / 10;
  }
  return json;
}

function registerEventRoutes(app, deps) {
  const { supabase, ah, verifiedUserId, geocodeCourse, haversineMiles, idsBlockedBy, isBanned, BANNED_ERROR, moderateFields, getUser, sendAdminEmail, notifyNewEvent } = deps;

  async function registrationsFor(eventIds) {
    if (eventIds.length === 0) return new Map();
    const { data, error } = await supabase
      .from('event_registrations')
      .select('event_id, user_id, user_name, status, hold_expires_at, checkout_url, created_at, amount_colones')
      .in('event_id', eventIds);
    if (error) throw error;
    const byEvent = new Map(eventIds.map(id => [id, []]));
    (data || []).forEach(r => byEvent.get(r.event_id).push(r));
    return byEvent;
  }

  // Rows added by hand in the Table Editor may not have coordinates yet —
  // look the course up once and save it, so distance works from then on.
  async function fillMissingCoordinates(rows) {
    for (const row of rows) {
      if (row.lat != null && row.lng != null) continue;
      const geo = await geocodeCourse(row.course);
      if (!geo) continue;
      row.lat = geo.lat; row.lng = geo.lng;
      await supabase.from('events').update({ lat: geo.lat, lng: geo.lng }).eq('id', row.id);
    }
  }

  // --- Public ------------------------------------------------------------

  // Upcoming open events, soonest first, with distance when lat/lng is sent.
  app.get('/api/events', ah(async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const { data: rows, error } = await supabase
      .from('events').select('*')
      .eq('status', 'open')
      .gt('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(100);
    if (error) return res.status(500).json({ error: 'Could not load events' });
    await fillMissingCoordinates(rows || []);
    const regs = await registrationsFor((rows || []).map(r => r.id));
    const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {};
    res.json({ events: (rows || []).map(r => eventJson(r, regs.get(r.id), { haversineMiles, ...here, lang: req.lang })) });
  }));

  // One event. Signed-in users see who's going; guests only see the count.
  app.get('/api/events/:id', ah(async (req, res) => {
    const { data: row, error } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
    if (error) return res.status(500).json({ error: 'Could not load event' });
    if (!row) return res.status(404).json({ error: 'Event not found' });
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const regs = (await registrationsFor([row.id])).get(row.id);
    const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {};
    const json = eventJson(row, regs, { haversineMiles, ...here, lang: req.lang });
    const viewerId = verifiedUserId(req);
    const mine = viewerId ? regs.find(r => r.user_id === viewerId && ['held', 'confirmed', 'refund_pending'].includes(r.status)) : null;
    json.myStatus = mine ? (mine.status === 'held' && !ACTIVE_HOLD(mine) ? null : mine.status) : null;
    // Your own unfinished payment, so the app can reopen the same page.
    if (mine && json.myStatus === 'held' && mine.checkout_url) json.myHold = { checkoutUrl: mine.checkout_url, holdExpiresAt: mine.hold_expires_at };
    if (req.authUser) {
      const blocked = await idsBlockedBy(req.authUser.id);
      json.attendees = regs
        .filter(r => r.status === 'confirmed' && !blocked.has(r.user_id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(r => ({ userId: r.user_id, name: r.user_name, photoUrl: deps.photoOf ? deps.photoOf(r.user_id) : null }));
    }
    res.json(json);
  }));

  // "Request an event": a regular user tells the owner where they'd like one.
  app.post('/api/event-requests', ah(async (req, res) => {
    const userId = verifiedUserId(req);
    if (!userId) return res.status(401).json({ error: 'Sign in required' });
    const course = String(req.body.course || '').trim().slice(0, 200);
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (course.length < 3) return res.status(400).json({ error: 'Tell us which course (at least 3 characters)' });
    const modError = moderateFields([course, note]);
    if (modError) return res.status(400).json(modError);
    if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
    // A few per day is plenty; this just stops accidental (or deliberate) floods.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('event_requests').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gte('created_at', since);
    if ((count || 0) >= 5) return res.status(429).json({ error: "You've sent a few requests today — thanks! Try again tomorrow." });
    const user = await getUser(userId);
    const userName = (user && user.name) || '';
    const { error } = await supabase.from('event_requests').insert({ user_id: userId, user_name: userName, course, note });
    if (error) {
      console.error('Failed to save event request:', error.message);
      return res.status(500).json({ error: 'Could not send your request' });
    }
    sendAdminEmail('Nueva solicitud de evento en Foursome / New event request', [
      'Alguien pidió un evento. (Someone asked for an event.)',
      '',
      `De / From: ${userName || '(sin nombre)'} (${userId})`,
      `Campo / Course: ${course}`,
      `Nota / Note: ${note || '(ninguna / none)'}`,
    ]).catch(() => {});
    res.json({ ok: true });
  }));

  // --- Owner only ----------------------------------------------------------

  app.get('/api/me/admin', (req, res) => {
    res.json({ isAdmin: isEventAdmin(req) });
  });

  function requireAdmin(req, res) {
    if (isEventAdmin(req)) return true;
    res.status(req.authUser ? 403 : 401).json({ error: 'Only the Foursome owner can do that' });
    return false;
  }

  // Validates the admin form. For an edit, `existing` and its registrations
  // decide what can still change.
  function parseEventInput(body) {
    const title = String(body.title || '').trim();
    const course = String(body.course || '').trim();
    const date = String(body.date || '');
    const time = String(body.time || '');
    const timeZone = String(body.timeZone || '');
    const priceColones = Math.round(Number(body.priceColones));
    const maxPlayers = Math.round(Number(body.maxPlayers));
    const cancelCutoffHours = Math.round(Number(body.cancelCutoffHours ?? 48));
    const description = String(body.description || '').trim();
    if (!title || title.length > 120) return { error: 'Title is required (up to 120 characters)' };
    if (!course || course.length > 200) return { error: 'Course is required' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { error: 'Pick a date and a time' };
    if (!isValidTimeZone(timeZone)) return { error: 'Pick the course time zone' };
    if (!Number.isFinite(priceColones) || priceColones < 500 || priceColones > 2000000) return { error: 'Price must be between ₡500 and ₡2,000,000' };
    if (!Number.isFinite(maxPlayers) || maxPlayers < 1 || maxPlayers > 500) return { error: 'Max players must be between 1 and 500' };
    if (!Number.isFinite(cancelCutoffHours) || cancelCutoffHours < 0 || cancelCutoffHours > 720) return { error: 'Cancellation cutoff must be 0–720 hours' };
    if (description.length > 2000) return { error: 'Description is too long (2,000 characters max)' };
    const startsAt = localToInstant(date, time, timeZone);
    if (!(startsAt > new Date())) return { error: 'The start time has to be in the future' };
    return { value: { title, course, starts_at: startsAt.toISOString(), time_zone: timeZone, price_colones: priceColones, max_players: maxPlayers, cancel_cutoff_hours: cancelCutoffHours, description } };
  }

  app.get('/api/admin/events', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { data: rows, error } = await supabase.from('events').select('*').order('starts_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: 'Could not load events' });
    const regs = await registrationsFor((rows || []).map(r => r.id));
    res.json({ events: (rows || []).map(r => eventJson(r, regs.get(r.id), { lang: req.lang })) });
  }));

  app.post('/api/admin/events', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = parseEventInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const geo = await geocodeCourse(parsed.value.course, req.body);
    const { data: row, error } = await supabase.from('events').insert({
      ...parsed.value, lat: geo ? geo.lat : null, lng: geo ? geo.lng : null, created_by: req.authUser.id,
    }).select().single();
    if (error) {
      console.error('Failed to create event:', error.message);
      return res.status(500).json({ error: 'Could not create the event' });
    }
    if (notifyNewEvent) notifyNewEvent(row); // in the background (notify.js)
    res.json(eventJson(row, [], { lang: req.lang }));
  }));

  app.post('/api/admin/events/:id', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { data: existing, error: loadError } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
    if (loadError) return res.status(500).json({ error: 'Could not load event' });
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    if (existing.status === 'cancelled') return res.status(400).json({ error: 'A cancelled event can’t be edited' });
    const parsed = parseEventInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const regs = (await registrationsFor([existing.id])).get(existing.id);
    const taken = regs.filter(r => r.status === 'confirmed' || ACTIVE_HOLD(r)).length;
    const anyPaid = regs.some(r => ['confirmed', 'refund_pending', 'refunded'].includes(r.status) || ACTIVE_HOLD(r));
    if (anyPaid && parsed.value.price_colones !== existing.price_colones) {
      return res.status(400).json({ error: 'People have already paid, so the price can’t change. Cancel and re-create the event instead.' });
    }
    if (parsed.value.max_players < taken) {
      return res.status(400).json({ error: `${taken} spot${taken === 1 ? ' is' : 's are'} already taken, so max players can’t go below that` });
    }
    const update = { ...parsed.value, updated_at: new Date().toISOString() };
    if (parsed.value.course !== existing.course || req.body.courseLat != null) {
      const geo = await geocodeCourse(parsed.value.course, req.body);
      update.lat = geo ? geo.lat : null;
      update.lng = geo ? geo.lng : null;
    }
    const { data: row, error } = await supabase.from('events').update(update).eq('id', existing.id).select().single();
    if (error) {
      console.error('Failed to update event:', error.message);
      return res.status(500).json({ error: 'Could not save the event' });
    }
    res.json(eventJson(row, regs, { lang: req.lang }));
  }));

  // Cancelling an event (with refunds) lives in eventPayments.js.

  // Requests still waiting (handled_at empty). Before supabase-dashboard.sql
  // there's no handled_at, so every request is listed.
  async function openEventRequests() {
    let { data, error } = await supabase.from('event_requests')
      .select('id, user_name, course, note, created_at, handled_at').is('handled_at', null).order('created_at', { ascending: false }).limit(100);
    let canHandle = true;
    if (error) {
      canHandle = false;
      ({ data, error } = await supabase.from('event_requests')
        .select('id, user_name, course, note, created_at').order('created_at', { ascending: false }).limit(100));
    }
    if (error) throw error;
    return { requests: (data || []).map(r => ({ id: r.id, userName: r.user_name, course: r.course, note: r.note, createdAt: r.created_at })), canHandle };
  }

  app.get('/api/admin/event-requests', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json(await openEventRequests());
    } catch (e) {
      res.status(500).json({ error: 'Could not load requests' });
    }
  }));

  app.post('/api/admin/event-requests/:id/handled', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { error } = await supabase.from('event_requests').update({ handled_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(400).json({ error: 'Run supabase-dashboard.sql first' });
    res.json({ ok: true });
  }));

  // Open reports (resolved_at empty), newest first, with names.
  async function openReports() {
    let { data, error } = await supabase.from('user_reports').select('*').is('resolved_at', null).order('created_at', { ascending: false }).limit(100);
    let canResolve = true;
    if (error) {
      canResolve = false;
      ({ data, error } = await supabase.from('user_reports').select('*').order('created_at', { ascending: false }).limit(100));
    }
    if (error) throw error;
    const ids = [...new Set((data || []).flatMap(r => [r.reporter_id, r.reported_id]))];
    const { data: people } = ids.length ? await supabase.from('users').select('user_id, name').in('user_id', ids) : { data: [] };
    const nameOf = new Map((people || []).map(p => [p.user_id, p.name]));
    const groupIds = [...new Set((data || []).map(r => r.group_id).filter(Boolean))];
    const groupOf = deps.groupNames && groupIds.length ? await deps.groupNames(groupIds).catch(() => new Map()) : new Map();
    return {
      reports: (data || []).map(r => {
        const g = r.group_id ? groupOf.get(r.group_id) : null;
        return {
          id: r.id, reason: r.reason, messageText: r.message_text || null, photoUrl: r.photo_url || null, createdAt: r.created_at,
          reporter: nameOf.get(r.reporter_id) || '?', reported: nameOf.get(r.reported_id) || '?', reportedId: r.reported_id,
          // A group's name/description or a group chat message.
          groupId: r.group_id || null, groupName: g ? g.name : null, groupRemoved: !!(g && g.removed_at),
          isGroupMessage: r.group_message_id != null,
        };
      }),
      canResolve,
    };
  }

  app.post('/api/admin/reports/:id/resolve', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { error } = await supabase.from('user_reports').update({ resolved_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(400).json({ error: 'Run supabase-dashboard.sql first' });
    res.json({ ok: true });
  }));

  // Manage > Dashboard: the numbers at a glance.
  app.get('/api/admin/dashboard', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const weekAgo = Date.now() - 7 * 24 * 3600e3;
    const { data: users, error: uErr } = await supabase.from('users').select('*');
    if (uErr) return res.status(500).json({ error: 'Could not load the dashboard' });
    const real = (users || []).filter(u => !(deps.DEMO_USER_IDS && deps.DEMO_USER_IDS.has(u.user_id)));
    // Sign-up date: created_at (after supabase-dashboard.sql), else consent date.
    const signedUpAt = u => Number(u.created_at || u.terms_agreed_at || 0);
    const { count: roundsThisWeek } = await supabase.from('teetimes').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo);

    const { data: events } = await supabase.from('events').select('*').eq('status', 'open').gt('starts_at', new Date().toISOString()).order('starts_at', { ascending: true });
    const regs = await registrationsFor((events || []).map(e => e.id));
    const upcoming = (events || []).map(ev => {
      const list = regs.get(ev.id) || [];
      const paid = list.filter(r => r.status === 'confirmed');
      return {
        id: ev.id, title: ev.title, course: ev.course, whenLabel: whenLabel(new Date(ev.starts_at), ev.time_zone, req.lang),
        sold: paid.length, maxPlayers: ev.max_players,
        revenueColones: paid.reduce((sum, r) => sum + (Number(r.amount_colones) || ev.price_colones), 0),
      };
    });

    const requests = await openEventRequests().catch(() => ({ requests: [], canHandle: false }));
    const reports = await openReports().catch(() => ({ reports: [], canResolve: false }));
    const groupList = deps.groupsForDashboard ? await deps.groupsForDashboard() : null;
    res.json({
      groups: groupList, // null until supabase-groups.sql is run
      totalUsers: real.length,
      signupsThisWeek: real.filter(u => signedUpAt(u) >= weekAgo).length,
      roundsThisWeek: roundsThisWeek || 0,
      upcomingEvents: upcoming,
      upcomingRevenueColones: upcoming.reduce((s, e) => s + e.revenueColones, 0),
      pendingRequests: requests.requests.length,
      openReports: reports.reports,
      // false until supabase-dashboard.sql is run
      ready: requests.canHandle && reports.canResolve && real.some(u => u.created_at != null),
    });
  }));
}

module.exports = { registerEventRoutes, isEventAdmin, localToInstant, whenLabel, eventJson, ACTIVE_HOLD };
