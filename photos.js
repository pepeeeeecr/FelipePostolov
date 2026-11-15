// Profile photos (see supabase-photos.sql and the "profile-photos" storage
// bucket).
//
// The app crops each photo square, shrinks it to 512 px and saves it as a
// JPEG (~50 KB) before uploading. Here it's checked (a real JPEG, not too
// big), stored as profile-photos/<userId>/<time>-<random>.jpg, and its
// public address saved in users.photo_url. The old file is deleted.
//
// photoOf(userId) is synchronous (an in-memory copy of everyone's photo
// address, refreshed every few minutes and on every change), so rounds,
// chat, requests and events can show photos without extra queries.
//
// Photos can be reported (POST /api/reports with { photo: true }); the
// owner removes one from the dashboard.

const crypto = require('crypto');

const BUCKET = 'profile-photos';
const MAX_BYTES = 600 * 1024;
const REFRESH_MS = 5 * 60 * 1000;

function makePhotos({ supabase }) {
  const photos = new Map(); // userId -> url
  let ready = false;
  let warned = false;

  const missing = e => e && /photo_url|column|schema cache|does not exist/i.test(e.message || '');
  function warn(e) {
    if (!warned) console.warn('Profile photos are off until supabase-photos.sql is run:', e.message);
    warned = true;
  }

  async function reload() {
    const { data, error } = await supabase.from('users').select('user_id, photo_url').not('photo_url', 'is', null);
    if (error) { if (missing(error)) warn(error); else console.error('Photo list failed:', error.message); return; }
    photos.clear();
    for (const r of data || []) if (r.photo_url) photos.set(r.user_id, r.photo_url);
    ready = true;
  }

  function start() {
    reload();
    setInterval(reload, REFRESH_MS).unref();
  }

  const photoOf = userId => (userId && photos.get(userId)) || null;

  // The storage path inside the bucket, from a public address.
  function pathOf(url) {
    const marker = `/object/public/${BUCKET}/`;
    const i = String(url || '').indexOf(marker);
    return i >= 0 ? decodeURIComponent(url.slice(i + marker.length).split('?')[0]) : null;
  }

  async function removeFile(url) {
    const path = pathOf(url);
    if (path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
  }

  async function setPhoto(userId, url) {
    const { error } = await supabase.from('users').update({ photo_url: url }).eq('user_id', userId);
    if (error) throw error;
    if (url) photos.set(userId, url); else photos.delete(userId);
  }

  // A JPEG starts with FF D8 FF and ends with FF D9.
  function isJpeg(buf) {
    return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff &&
      buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  }

  async function upload(userId, base64) {
    const buf = Buffer.from(String(base64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (!buf.length) return { status: 400, error: 'No photo received' };
    if (buf.length > MAX_BYTES) return { status: 400, error: 'That photo is too big' };
    if (!isJpeg(buf)) return { status: 400, error: 'That photo couldn’t be read — try another one' };
    const path = `${userId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
    if (upErr) {
      console.error('Photo upload failed:', upErr.message);
      return { status: 503, error: /bucket/i.test(upErr.message) ? 'Photos aren’t set up yet' : 'Could not save the photo' };
    }
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const old = photoOf(userId);
    try {
      await setPhoto(userId, data.publicUrl);
    } catch (e) {
      await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
      if (missing(e)) { warn(e); return { status: 503, error: 'Photos aren’t set up yet' }; }
      return { status: 500, error: 'Could not save the photo' };
    }
    if (old) await removeFile(old);
    return { status: 200, photoUrl: data.publicUrl };
  }

  async function remove(userId) {
    const old = photoOf(userId);
    await setPhoto(userId, null);
    if (old) await removeFile(old);
  }

  function registerRoutes(app, { ah, verifiedUserId, isBanned, BANNED_ERROR, requireOwner }) {
    app.post('/api/me/photo', ah(async (req, res) => {
      const userId = verifiedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Sign in required' });
      if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
      const out = await upload(userId, req.body.imageBase64);
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ photoUrl: out.photoUrl });
    }));

    app.delete('/api/me/photo', ah(async (req, res) => {
      const userId = verifiedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Sign in required' });
      try { await remove(userId); } catch (e) { return res.status(500).json({ error: 'Could not remove the photo' }); }
      res.json({ ok: true });
    }));

    // Owner: take someone's photo down (from a report), and close the
    // photo reports about them.
    app.post('/api/admin/users/:id/remove-photo', ah(async (req, res) => {
      if (!requireOwner(req, res)) return;
      try { await remove(req.params.id); } catch (e) { return res.status(500).json({ error: 'Could not remove the photo' }); }
      await supabase.from('user_reports').update({ resolved_at: new Date().toISOString() })
        .eq('reported_id', req.params.id).not('photo_url', 'is', null).is('resolved_at', null).then(() => {}, () => {});
      res.json({ ok: true });
    }));
  }

  return { start, photoOf, upload, remove, registerRoutes, isReady: () => ready, _isJpeg: isJpeg, _pathOf: pathOf };
}

module.exports = { makePhotos, PHOTO_BUCKET: BUCKET };
