// Partner courses (see supabase-partner-courses.sql).
//
// The owner marks a course as a partner in Manage. Each partner course gets:
// - /c/<slug>: a public page (Spanish or English, from the browser) with the
//   course's upcoming open rounds and events, links to each, "Open in
//   Foursome" (the course page in the app) and "Get the app".
// - /c/<slug>/poster: a printable poster with a big QR code to that page.
// /c/ isn't a Universal Link on purpose: scanning the poster should always
// show the page, app or not.

const QRCode = require('qrcode');
const { whenLabel } = require('./events');
const places = require('./places');
const { pickLang } = require('./i18n');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://felipepostolov.onrender.com';
const APP_STORE_URL = 'https://apps.apple.com/app/id6831230794';
const NEAR_KM = 2; // a round or event within 2 km counts as at the course
const NOT_READY = 'Partner courses aren’t set up yet';
const tableMissing = e => !!e && /partner_courses|does not exist|schema cache|relation/i.test(e.message || '');

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = s => fold(s).replace(/\s+/g, '-').slice(0, 50) || 'course';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const colones = n => '₡' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function km(a, b) {
  const R = 6371, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const T = {
  es: {
    tagline: 'Encontrá con quién jugar golf aquí', rounds: 'Rondas abiertas', events: 'Eventos', none: 'Todavía no hay rondas abiertas. Descargá la app y publicá la tuya.',
    spots: n => `${n} ${n === 1 ? 'espacio libre' : 'espacios libres'}`, open: 'Abrir en Foursome', get: 'Descargar la app', host: 'Organiza',
    blurb: 'Foursome te ayuda a encontrar con quién jugar golf.', scan: 'Escaneá para ver las rondas abiertas', posterTitle: '¿Buscás con quién jugar?',
    posterBody: 'Mirá las rondas y eventos abiertos en este campo, o publicá la tuya, con la app Foursome.', print: 'Imprimir', partner: 'Campo aliado de Foursome',
  },
  en: {
    tagline: 'Find people to play golf with here', rounds: 'Open rounds', events: 'Events', none: 'No open rounds yet. Get the app and post yours.',
    spots: n => `${n} ${n === 1 ? 'spot' : 'spots'} open`, open: 'Open in Foursome', get: 'Get the app', host: 'Hosted by',
    blurb: 'Foursome helps golfers find people to play with.', scan: 'Scan to see open rounds', posterTitle: 'Looking for a game?',
    posterBody: 'See open rounds and events at this course, or post your own, with the Foursome app.', print: 'Print', partner: 'Foursome partner course',
  },
};

function makePartners(deps) {
  const { supabase, DEMO_USER_IDS, getBannedUserIds } = deps;
  let warned = false;
  const warn = e => { if (!warned) console.warn('Partner courses are off until supabase-partner-courses.sql is run:', e.message); warned = true; };

  const appLink = p => `foursomemobile://course?name=${encodeURIComponent(p.name)}${p.lat != null ? `&lat=${p.lat}&lng=${p.lng}` : ''}`;
  const pageUrl = p => `${PUBLIC_URL}/c/${p.slug}`;
  const atCourse = (p, name, lat, lng) => fold(name) === fold(p.name) ||
    (p.lat != null && lat != null && lng != null && km({ lat: p.lat, lng: p.lng }, { lat, lng }) <= NEAR_KM);

  // Upcoming open rounds (not members-only group rounds) and open events at the course.
  async function upcomingAt(p, lang) {
    const today = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10);
    const [{ data: rounds }, { data: events }, banned] = await Promise.all([
      supabase.from('teetimes').select('*').neq('status', 'cancelled').gte('date', today).gt('open_spots', 0),
      supabase.from('events').select('*').eq('status', 'open').gt('starts_at', new Date().toISOString()),
      getBannedUserIds().catch(() => new Set()),
    ]);
    const r = (rounds || [])
      .filter(rd => !DEMO_USER_IDS.has(rd.host_id) && !banned.has(rd.host_id) && (!rd.group_id || rd.open_to_all))
      .filter(rd => atCourse(p, rd.course, rd.lat, rd.lng))
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).slice(0, 20);
    const e = (events || []).filter(ev => atCourse(p, ev.course, ev.lat, ev.lng))
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 10)
      .map(ev => ({ ...ev, when: whenLabel(new Date(ev.starts_at), ev.time_zone, lang) }));
    return { rounds: r, events: e };
  }

  async function bySlug(slug) {
    const { data, error } = await supabase.from('partner_courses').select('*').eq('slug', String(slug).toLowerCase()).maybeSingle();
    if (error) throw error;
    return data && data.active ? data : null;
  }

  function shell(lang, title, body, { description, print = false } = {}) {
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Foursome</title>
<meta property="og:title" content="${esc(title)}"><meta property="og:site_name" content="Foursome">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
${print ? '' : '<meta name="apple-itunes-app" content="app-id=6831230794">'}
<style>
body{margin:0;background:#F6F3EC;color:#1C2A1F;font-family:-apple-system,system-ui,'Helvetica Neue',Arial,sans-serif}
.wrap{max-width:520px;margin:0 auto;padding:36px 18px 48px}
.brand{font:700 13px Georgia,serif;letter-spacing:2px;color:#2E5E3A;text-align:center;margin-bottom:18px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px;opacity:.75;text-transform:uppercase;letter-spacing:.5px}
.muted{opacity:.7;font-size:14px;margin:2px 0}
a.card{display:block;background:#fff;border:1px solid rgba(28,42,31,.12);border-radius:14px;padding:13px 15px;margin:8px 0;color:inherit;text-decoration:none}
.card b{display:block;font-size:15px;margin-bottom:2px}
.btn{display:block;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-top:10px}
.primary{background:#2E5E3A;color:#fff}.ghost{border:1px solid #2E5E3A;color:#2E5E3A}
</style></head><body>${body}</body></html>`;
  }

  function registerRoutes(app, { ah, requireOwner }) {
    // Public page.
    app.get('/c/:slug', ah(async (req, res) => {
      const lang = pickLang(req);
      const t = T[lang];
      let p;
      try { p = await bySlug(req.params.slug); } catch (e) { if (tableMissing(e)) warn(e); p = null; }
      if (!p) return res.status(404).send(shell(lang, 'Foursome', `<div class="wrap"><div class="brand">FOURSOME</div><p class="muted" style="text-align:center">${lang === 'en' ? 'This page isn’t available.' : 'Esta página no está disponible.'}</p></div>`));
      const where = places.fields(p.lat, p.lng, lang).placeFull;
      const { rounds, events } = await upcomingAt(p, lang);
      const roundCards = rounds.map(rd => `<a class="card" href="${esc(PUBLIC_URL)}/r/${encodeURIComponent(rd.id)}"><b>${esc(rd.date)} · ${esc(rd.time)}</b><span class="muted">${esc(t.spots(rd.open_spots))} · ${esc(t.host)} ${esc(rd.host_name)}</span></a>`).join('');
      const eventCards = events.map(ev => `<a class="card" href="${esc(PUBLIC_URL)}/e/${ev.id}"><b>${esc(ev.title)}</b><span class="muted">${esc(ev.when)} · ${esc(colones(ev.price_colones))}</span></a>`).join('');
      const body = `<div class="wrap"><div class="brand">FOURSOME</div>
<p class="muted">${esc(t.partner)}</p><h1>${esc(p.name)}</h1>${where ? `<p class="muted">${esc(where)}</p>` : ''}
<p class="muted" style="margin-top:10px">${esc(t.tagline)}</p>
${events.length ? `<h2>${esc(t.events)}</h2>${eventCards}` : ''}
<h2>${esc(t.rounds)}</h2>${rounds.length ? roundCards : `<p class="muted">${esc(t.none)}</p>`}
<a class="btn primary" href="${esc(appLink(p))}">${esc(t.open)}</a>
<a class="btn ghost" href="${APP_STORE_URL}">${esc(t.get)}</a>
<p class="muted" style="text-align:center;margin-top:22px">${esc(t.blurb)}</p></div>`;
      res.set('Cache-Control', 'no-store').send(shell(lang, p.name, body, { description: t.tagline }));
    }));

    // Printable poster (A4 / Letter) with a QR code to the page. ?lang=en|es.
    app.get('/c/:slug/poster', ah(async (req, res) => {
      const lang = req.query.lang === 'en' ? 'en' : req.query.lang === 'es' ? 'es' : pickLang(req);
      const t = T[lang];
      let p;
      try { p = await bySlug(req.params.slug); } catch (e) { p = null; }
      if (!p) return res.status(404).send('Not found');
      const qr = await QRCode.toString(pageUrl(p), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#16281B', light: '#FFFFFF' } });
      const body = `<style>
@page{size:auto;margin:14mm}
.poster{max-width:180mm;margin:0 auto;padding:24px 18px;text-align:center;background:#fff;min-height:250mm;box-sizing:border-box}
.poster h1{font:700 40px Georgia,serif;margin:18px 0 8px}.poster .course{font-size:26px;font-weight:700;margin:6px 0 2px}
.qr{width:110mm;max-width:80vw;margin:22px auto 8px}.qr svg{width:100%;height:auto}
.scan{font-size:20px;font-weight:600}.url{font-size:13px;opacity:.6;margin-top:6px;word-break:break-all}
.printbtn{position:fixed;top:12px;right:12px;background:#2E5E3A;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:600;font-size:15px}
@media print{.printbtn{display:none}body{background:#fff}}
</style>
<button class="printbtn" onclick="window.print()">${esc(t.print)}</button>
<div class="poster"><div class="brand" style="font-size:18px;margin-top:6px">FOURSOME</div>
<h1>${esc(t.posterTitle)}</h1><div class="course">${esc(p.name)}</div>
<p style="font-size:17px;opacity:.8;max-width:130mm;margin:10px auto 0;line-height:1.4">${esc(t.posterBody)}</p>
<div class="qr">${qr}</div><div class="scan">${esc(t.scan)}</div><div class="url">${esc(pageUrl(p))}</div></div>`;
      res.set('Cache-Control', 'no-store').send(shell(lang, `${t.posterTitle} · ${p.name}`, body, { print: true }));
    }));

    // --- Owner (Manage) -------------------------------------------------------
    const json = p => ({ id: p.id, slug: p.slug, name: p.name, lat: p.lat, lng: p.lng, pageUrl: pageUrl(p), posterUrl: `${pageUrl(p)}/poster` });
    const guarded = fn => ah(async (req, res) => {
      if (!requireOwner(req, res)) return;
      try { await fn(req, res); } catch (e) {
        if (tableMissing(e)) { warn(e); return res.status(503).json({ error: NOT_READY }); }
        throw e;
      }
    });

    app.get('/api/admin/partners', guarded(async (req, res) => {
      const { data, error } = await supabase.from('partner_courses').select('*').eq('active', true).order('name', { ascending: true });
      if (error) throw error;
      res.json({ partners: (data || []).map(json) });
    }));

    app.post('/api/admin/partners', guarded(async (req, res) => {
      const name = String(req.body.name || '').trim().slice(0, 120);
      if (name.length < 3) return res.status(400).json({ error: 'Course is required' });
      const lat = Number(req.body.lat), lng = Number(req.body.lng);
      const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
      const geo = hasGeo ? { lat, lng } : (deps.geocodeCourse ? await deps.geocodeCourse(name) : null);
      // Already a partner (same name): turn it back on.
      const { data: all, error: listErr } = await supabase.from('partner_courses').select('*');
      if (listErr) throw listErr;
      const same = (all || []).find(p => fold(p.name) === fold(name));
      if (same) {
        await supabase.from('partner_courses').update({ active: true, ...(geo ? { lat: geo.lat, lng: geo.lng } : {}) }).eq('id', same.id);
        return res.json(json({ ...same, ...(geo || {}) }));
      }
      const taken = new Set((all || []).map(p => p.slug));
      let slug = slugify(name);
      for (let i = 2; taken.has(slug); i++) slug = `${slugify(name)}-${i}`;
      const row = { slug, name, lat: geo ? geo.lat : null, lng: geo ? geo.lng : null, active: true };
      const { error } = await supabase.from('partner_courses').insert(row);
      if (error) throw error;
      res.json(json(row));
    }));

    app.post('/api/admin/partners/:id/remove', guarded(async (req, res) => {
      const { error } = await supabase.from('partner_courses').update({ active: false }).eq('id', Number(req.params.id));
      if (error) throw error;
      res.json({ ok: true });
    }));
  }

  return { registerRoutes, upcomingAt, slugify };
}

module.exports = { makePartners, slugify, fold };
