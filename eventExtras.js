// Event extras (see supabase-event-extras.sql):
//
// - Waitlist: when an event is full, signed-in people can join its waitlist.
//   Every minute, free spots are offered to the next person in line: the
//   spot is kept for them for 2 hours (or until the event starts) and they
//   get a notification. If they don't pay in time it moves on.
// - Discount codes the owner creates in Manage: percent or a fixed amount
//   off, a use limit, an expiry date, any event or one event.
// - A price quote for the pay button (spots × price, minus a code).
// - Results and photos the owner posts on an event's page after it.
//
// The binding checks (spots left, code uses) happen in the database, in
// reserve_event_spots; the quote is only a preview.

const crypto = require('crypto');

const OFFER_HOURS = 2;
const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 1500 * 1024;
const PHOTO_BUCKET = 'profile-photos'; // the existing public bucket, under events/<id>/
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://felipepostolov.onrender.com';
const NOT_READY = 'Event extras aren’t set up yet';
const tableMissing = e => !!e && /discount_codes|event_waitlist|results_|guest_|spots|does not exist|schema cache|relation/i.test(e.message || '');

const spotsOf = r => Math.max(1, Number(r.spots) || 1);
const activeHold = r => r.status === 'held' && r.hold_expires_at && new Date(r.hold_expires_at) > new Date();
const isJpeg = b => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

// The same sum the database does: price × spots, minus the code, never
// below ₡500 (ONVO's minimum).
function priceFor(priceColones, spots, code) {
  const total = priceColones * spots;
  let off = 0;
  if (code) off = code.kind === 'percent' ? Math.round(total * Math.min(code.amount, 100) / 100) : code.amount;
  const due = Math.max(total - off, Math.min(total, 500));
  return { totalColones: total, discountColones: total - due, dueColones: due };
}

function makeEventExtras(deps) {
  const { supabase, notifyUser, isEventAdmin, localToInstant } = deps;
  let warned = false;
  const warn = e => { if (!warned) console.warn('Event extras are off until supabase-event-extras.sql is run:', e.message); warned = true; };

  // --- Waitlist --------------------------------------------------------------
  // Active offers per event: Map(eventId → [userId]), for spotsLeft.
  async function activeOffers(eventIds) {
    const out = new Map();
    if (!eventIds.length) return out;
    const { data, error } = await supabase.from('event_waitlist').select('event_id, user_id, status, offered_until').in('event_id', eventIds).eq('status', 'offered');
    if (error) { if (tableMissing(error)) warn(error); return out; }
    for (const w of data || []) {
      if (!(new Date(w.offered_until) > new Date())) continue;
      if (!out.has(w.event_id)) out.set(w.event_id, []);
      out.get(w.event_id).push(w.user_id);
    }
    return out;
  }

  // Spots taken: paid, held, and kept for someone on the waitlist who
  // hasn't started paying (their hold is counted already once they do).
  function takenSpots(regs, offers, exceptUser) {
    const busy = new Set();
    let n = 0;
    for (const r of regs) {
      if (r.status === 'confirmed' || activeHold(r)) { n += spotsOf(r); busy.add(r.user_id); }
    }
    for (const u of offers || []) if (u !== exceptUser && !busy.has(u)) n += 1;
    return n;
  }

  async function myWaitlist(eventId, userId) {
    if (!userId) return null;
    const { data, error } = await supabase.from('event_waitlist').select('*').eq('event_id', eventId).in('status', ['waiting', 'offered']);
    if (error) return null;
    const line = (data || []).filter(w => w.status === 'waiting').sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
    const mine = (data || []).find(w => w.user_id === userId);
    if (!mine) return { joined: false, waitingCount: line.length };
    if (mine.status === 'offered' && !(new Date(mine.offered_until) > new Date())) return { joined: false, waitingCount: line.length };
    return {
      joined: true, status: mine.status, offeredUntil: mine.status === 'offered' ? mine.offered_until : null,
      position: mine.status === 'waiting' ? line.findIndex(w => w.id === mine.id) + 1 : null, waitingCount: line.length,
    };
  }

  // Every minute: lapsed offers move on, and free spots go to the next
  // person waiting. Returns how many offers were made.
  async function processWaitlists(now = new Date()) {
    let made = 0;
    const { data: lapsed, error } = await supabase.from('event_waitlist').select('*').eq('status', 'offered').lt('offered_until', now.toISOString());
    if (error) { if (tableMissing(error)) warn(error); else console.error('Waitlist check failed:', error.message); return 0; }
    for (const w of lapsed || []) {
      await supabase.from('event_waitlist').update({ status: 'expired', updated_at: now.toISOString() }).eq('id', w.id).eq('status', 'offered');
    }
    const { data: waiting } = await supabase.from('event_waitlist').select('*').eq('status', 'waiting');
    const eventIds = [...new Set((waiting || []).map(w => w.event_id))];
    if (!eventIds.length) return 0;
    const { data: events } = await supabase.from('events').select('*').in('id', eventIds);
    const offers = await activeOffers(eventIds);
    for (const ev of events || []) {
      const lineAll = (waiting || []).filter(w => w.event_id === ev.id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
      if (ev.status !== 'open' || !(new Date(ev.starts_at) > now)) {
        for (const w of lineAll) await supabase.from('event_waitlist').update({ status: 'expired', updated_at: now.toISOString() }).eq('id', w.id);
        continue;
      }
      const { data: regs } = await supabase.from('event_registrations').select('*').eq('event_id', ev.id);
      const holding = new Set((regs || []).filter(r => r.status === 'confirmed' || activeHold(r)).map(r => r.user_id));
      let free = ev.max_players - takenSpots(regs || [], offers.get(ev.id) || []);
      for (const w of lineAll) {
        if (free <= 0) break;
        if (holding.has(w.user_id)) { // already got in another way
          await supabase.from('event_waitlist').update({ status: 'claimed', updated_at: now.toISOString() }).eq('id', w.id);
          continue;
        }
        const until = new Date(Math.min(now.getTime() + OFFER_HOURS * 3600e3, new Date(ev.starts_at).getTime()));
        const { data: claimed } = await supabase.from('event_waitlist')
          .update({ status: 'offered', offered_until: until.toISOString(), updated_at: now.toISOString() })
          .eq('id', w.id).eq('status', 'waiting').select('*').maybeSingle();
        if (!claimed) continue;
        free -= 1;
        made += 1;
        notifyUser(w.user_id, lang => lang === 'en'
          ? [`A spot opened: ${ev.title}`, `It's yours for ${OFFER_HOURS} hours — pay before then or it goes to the next person.`]
          : [`Se abrió un espacio: ${ev.title}`, `Es tuyo por ${OFFER_HOURS} horas. Pagá antes o pasa a la siguiente persona.`],
        null, { data: { url: `${PUBLIC_URL}/e/${ev.id}` } }).catch(() => {});
      }
    }
    return made;
  }

  // --- Discount codes ----------------------------------------------------------
  async function findCode(code, eventId) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return { code: null };
    const { data, error } = await supabase.from('discount_codes').select('*').eq('code', clean).maybeSingle();
    if (error) throw error;
    if (!data || !data.active || !(new Date(data.expires_at) > new Date()) || (data.event_id != null && Number(data.event_id) !== Number(eventId))) {
      return { error: 'That code isn’t valid' };
    }
    const used = await usesOf([data.id]);
    if ((used.get(data.id) || 0) >= data.max_uses) return { error: 'That code has been used up' };
    return { code: data };
  }

  async function usesOf(codeIds) {
    const out = new Map();
    if (!codeIds.length) return out;
    const { data } = await supabase.from('event_registrations').select('discount_code_id, status, hold_expires_at').in('discount_code_id', codeIds);
    for (const r of data || []) {
      if (['confirmed', 'refund_pending', 'refund_manual', 'refunded'].includes(r.status) || activeHold(r)) out.set(r.discount_code_id, (out.get(r.discount_code_id) || 0) + 1);
    }
    return out;
  }

  function codeJson(c, uses) {
    return {
      id: c.id, code: c.code, kind: c.kind, amount: c.amount, maxUses: c.max_uses, uses: uses || 0,
      expiresAt: c.expires_at, eventId: c.event_id, active: c.active && new Date(c.expires_at) > new Date(),
    };
  }

  // --- Results and photos ------------------------------------------------------
  function resultsJson(row) {
    if (!row.results_posted_at && !(row.results_photos || []).length) return null;
    return { text: row.results_text || '', photos: row.results_photos || [], postedAt: row.results_posted_at };
  }

  function registerRoutes(app, { ah, verifiedUserId }) {
    const requireOwner = (req, res) => {
      if (isEventAdmin(req)) return true;
      res.status(req.authUser ? 403 : 401).json({ error: 'Only the Foursome owner can do that' });
      return false;
    };
    const safe = fn => ah(async (req, res) => {
      try { await fn(req, res); } catch (e) {
        if (tableMissing(e)) { warn(e); return res.status(503).json({ error: NOT_READY }); }
        throw e;
      }
    });
    const loadEvent = async (id) => {
      const { data, error } = await supabase.from('events').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    };

    // The price for n spots with a code (a preview; the database decides).
    app.post('/api/events/:id/quote', safe(async (req, res) => {
      const ev = await loadEvent(req.params.id);
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      const spots = Math.min(4, Math.max(1, Math.round(Number(req.body.spots) || 1)));
      let code = null;
      if (String(req.body.code || '').trim()) {
        const found = await findCode(req.body.code, ev.id);
        if (found.error) return res.json({ ...priceFor(ev.price_colones, spots, null), codeError: found.error });
        code = found.code;
      }
      res.json({ ...priceFor(ev.price_colones, spots, code), code: code ? code.code : null });
    }));

    // Join or leave the waitlist (signed-in accounts only, like paying).
    app.post('/api/events/:id/waitlist', safe(async (req, res) => {
      if (!req.authUser) return res.status(403).json({ error: 'Create an account or log in to join paid events', code: 'account_required' });
      const userId = req.authUser.id;
      const ev = await loadEvent(req.params.id);
      if (!ev || ev.status !== 'open' || !(new Date(ev.starts_at) > new Date())) return res.status(409).json({ error: 'This event is no longer open' });
      const { data: regs, error } = await supabase.from('event_registrations').select('*').eq('event_id', ev.id);
      if (error) throw error;
      if ((regs || []).some(r => r.user_id === userId && (r.status === 'confirmed' || activeHold(r)))) return res.status(409).json({ error: 'You already have a spot' });
      const offers = (await activeOffers([ev.id])).get(ev.id) || [];
      if (takenSpots(regs || [], offers, userId) < ev.max_players) return res.status(409).json({ error: 'There are spots left — you can pay now', code: 'not_full' });
      const user = deps.getUser ? await deps.getUser(userId) : null;
      const { error: insErr } = await supabase.from('event_waitlist').insert({ event_id: ev.id, user_id: userId, user_name: (user && user.name) || '' });
      if (insErr && !/duplicate|unique/i.test(insErr.message)) throw insErr;
      res.json({ ok: true, waitlist: await myWaitlist(ev.id, userId) });
    }));

    app.delete('/api/events/:id/waitlist', safe(async (req, res) => {
      if (!req.authUser) return res.status(403).json({ error: 'Log in to manage your spot', code: 'account_required' });
      const { error } = await supabase.from('event_waitlist').update({ status: 'left', updated_at: new Date().toISOString() })
        .eq('event_id', Number(req.params.id)).eq('user_id', req.authUser.id).in('status', ['waiting', 'offered']);
      if (error) throw error;
      res.json({ ok: true });
    }));

    // --- Owner: discount codes ---------------------------------------------------
    app.get('/api/admin/discount-codes', safe(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const { data, error } = await supabase.from('discount_codes').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const uses = await usesOf((data || []).map(c => c.id));
      res.json({ codes: (data || []).map(c => codeJson(c, uses.get(c.id))) });
    }));

    app.post('/api/admin/discount-codes', safe(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const code = String(req.body.code || '').trim().toUpperCase();
      const kind = req.body.kind === 'fixed' ? 'fixed' : 'percent';
      const amount = Math.round(Number(req.body.amount));
      const maxUses = Math.round(Number(req.body.maxUses));
      const expiresOn = String(req.body.expiresOn || '');
      const eventId = req.body.eventId ? Number(req.body.eventId) : null;
      if (!/^[A-Z0-9_-]{3,20}$/.test(code)) return res.status(400).json({ error: 'Codes are 3–20 letters or numbers' });
      if (kind === 'percent' && !(amount >= 1 && amount <= 100)) return res.status(400).json({ error: 'A percent discount is 1 to 100' });
      if (kind === 'fixed' && !(amount >= 100 && amount <= 2000000)) return res.status(400).json({ error: 'A fixed discount is ₡100 to ₡2,000,000' });
      if (!(maxUses >= 1 && maxUses <= 10000)) return res.status(400).json({ error: 'Uses must be between 1 and 10,000' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return res.status(400).json({ error: 'Pick an expiry date' });
      // Valid through the end of that day in Costa Rica.
      const expiresAt = localToInstant(expiresOn, '23:59', 'America/Costa_Rica');
      if (!(expiresAt > new Date())) return res.status(400).json({ error: 'The expiry date has to be in the future' });
      const { error } = await supabase.from('discount_codes').insert({ code, kind, amount, max_uses: maxUses, expires_at: expiresAt.toISOString(), event_id: eventId });
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return res.status(400).json({ error: 'There’s already a code with that name' });
        throw error;
      }
      res.json({ ok: true });
    }));

    app.post('/api/admin/discount-codes/:id/deactivate', safe(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const { error } = await supabase.from('discount_codes').update({ active: false }).eq('id', Number(req.params.id));
      if (error) throw error;
      res.json({ ok: true });
    }));

    // --- Owner: results and photos (after the event has started) -----------------
    const afterStart = (ev, res) => {
      if (!ev) { res.status(404).json({ error: 'Event not found' }); return false; }
      if (new Date(ev.starts_at) > new Date()) { res.status(400).json({ error: 'You can post results once the event has started' }); return false; }
      return true;
    };

    app.post('/api/admin/events/:id/results', safe(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const ev = await loadEvent(req.params.id);
      if (!afterStart(ev, res)) return;
      const text = String(req.body.text || '').trim();
      if (text.length > 4000) return res.status(400).json({ error: 'Results are too long (4,000 characters max)' });
      const { error } = await supabase.from('events').update({ results_text: text, results_posted_at: new Date().toISOString() }).eq('id', ev.id);
      if (error) throw error;
      res.json({ ok: true });
    }));

    app.post('/api/admin/events/:id/photos', safe(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const ev = await loadEvent(req.params.id);
      if (!afterStart(ev, res)) return;
      const photos = ev.results_photos || [];
      if (photos.length >= MAX_PHOTOS) return res.status(400).json({ error: 'That’s the most photos for one event (12)' });
      const buf = Buffer.from(String(req.body.imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (!buf.length) return res.status(400).json({ error: 'No photo received' });
      if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'That photo is too big' });
      if (!isJpeg(buf)) return res.status(400).json({ error: 'That photo couldn’t be read — try another one' });
      const path = `events/${ev.id}/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.jpg`;
      const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
      if (upErr) { console.error('Event photo upload failed:', upErr.message); return res.status(503).json({ error: 'Could not save the photo' }); }
      const url = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
      const { error } = await supabase.from('events').update({ results_photos: [...photos, url], results_posted_at: ev.results_posted_at || new Date().toISOString() }).eq('id', ev.id);
      if (error) { await supabase.storage.from(PHOTO_BUCKET).remove([path]).catch(() => {}); throw error; }
      res.json({ ok: true, url });
    }));

    app.post('/api/admin/events/:id/photos/remove', safe(async (req, res) => {
      if (!requireOwner(req, res)) return;
      const ev = await loadEvent(req.params.id);
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      const url = String(req.body.url || '');
      const photos = (ev.results_photos || []).filter(u => u !== url);
      const { error } = await supabase.from('events').update({ results_photos: photos }).eq('id', ev.id);
      if (error) throw error;
      const marker = `/object/public/${PHOTO_BUCKET}/`;
      const i = url.indexOf(marker);
      if (i >= 0) await supabase.storage.from(PHOTO_BUCKET).remove([decodeURIComponent(url.slice(i + marker.length).split('?')[0])]).catch(() => {});
      res.json({ ok: true });
    }));
  }

  return { registerRoutes, processWaitlists, activeOffers, takenSpots, myWaitlist, resultsJson, findCode, usesOf };
}

module.exports = { makeEventExtras, priceFor, spotsOf };
