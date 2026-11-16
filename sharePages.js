// Shared links for rounds and events: /r/:id and /e/:id.
//
// With the app installed (from the next build on, via Universal Links —
// see the apple-app-site-association route below) the link opens the app
// straight to that round or event. Otherwise it's this small page with the
// details, an "Open in Foursome" button and a "Get the app" button.

const { whenLabel } = require('./events');

const { APP_STORE_URL, appStoreButton } = require('./appStore');
const APPLE_APP_ID = 'C8S8FTV64A.com.felipepostolov.foursome'; // Team ID + bundle ID

const { pickLang } = require('./i18n');
const places = require('./places');

const T = {
  es: {
    round: 'Ronda abierta', event: 'Evento Foursome', spots: n => `${n} ${n === 1 ? 'espacio libre' : 'espacios libres'}`,
    full: 'Lleno', hcp: 'Hándicap', open: 'Abrir en Foursome', get: 'Descargar la app',
    gone: 'Esta ronda o evento ya no está disponible.', price: 'Precio',
    blurb: 'Foursome te ayuda a encontrar con quién jugar golf.',
    group: 'Te invitaron al grupo', groupGone: 'Este enlace de invitación ya no funciona.',
  },
  en: {
    round: 'Open round', event: 'Foursome event', spots: n => `${n} ${n === 1 ? 'spot' : 'spots'} open`,
    full: 'Full', hcp: 'Handicap', open: 'Open in Foursome', get: 'Get the app',
    gone: 'This round or event is no longer available.', price: 'Price',
    blurb: 'Foursome helps golfers find people to play with.',
    group: "You're invited to join", groupGone: 'This invite link no longer works.',
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function colones(n) {
  return '₡' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function page(lang, { title, lines, appLink, description }) {
  const t = T[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Foursome</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description || lines.join(' · '))}">
<meta property="og:site_name" content="Foursome">
<meta name="apple-itunes-app" content="app-id=6831230794${appLink ? `, app-argument=${esc(appLink)}` : ''}">
</head><body style="margin:0;background:#F6F3EC;color:#1C2A1F;font-family:-apple-system,system-ui,'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:440px;margin:0 auto;padding:48px 20px;text-align:center;">
<div style="font:700 13px Georgia,serif;letter-spacing:2px;color:#2E5E3A;margin-bottom:24px;">FOURSOME</div>
<div style="background:#fff;border:1px solid rgba(28,42,31,.12);border-radius:16px;padding:22px 18px;text-align:left;">
<h1 style="font-size:20px;margin:0 0 10px;">${esc(title)}</h1>
${lines.map(l => `<p style="margin:4px 0;font-size:15px;opacity:.8;">${esc(l)}</p>`).join('')}
</div>
${appLink ? `<a href="${esc(appLink)}" style="display:block;margin-top:20px;background:#2E5E3A;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:600;">${t.open}</a>` : ''}
${appStoreButton(lang, 'display:block;margin-top:10px;border:1px solid #2E5E3A;color:#2E5E3A;text-decoration:none;padding:13px;border-radius:12px;font-weight:600;')}
<p style="margin-top:22px;font-size:13px;opacity:.6;">${t.blurb}</p>
</div></body></html>`;
}

function registerSharePages(app, { supabase, ah, DEMO_USER_IDS, eventJson }) {
  // Lets iOS open /r/… and /e/… links in the app (Universal Links).
  app.get('/.well-known/apple-app-site-association', (req, res) => {
    res.type('application/json').send(JSON.stringify({
      applinks: { apps: [], details: [{ appID: APPLE_APP_ID, paths: ['/r/*', '/e/*', '/g/*'] }] },
    }));
  });

  // "Add to calendar": a calendar file iOS opens straight into Calendar.
  // Rounds have no time zone, so their time is "floating" (the phone's own
  // zone, which is where the player is); events use their real start time.
  const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
  const icsUtc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  function sendIcs(res, { uid, start, end, floating, title, location, description, url }) {
    const stamp = icsUtc(new Date());
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Foursome//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', `UID:${uid}@foursome`, `DTSTAMP:${stamp}`,
      floating ? `DTSTART:${start}` : `DTSTART:${icsUtc(start)}`,
      floating ? `DTEND:${end}` : `DTEND:${icsUtc(end)}`,
      `SUMMARY:${icsText(title)}`, `LOCATION:${icsText(location)}`, `DESCRIPTION:${icsText(description)}`, `URL:${url}`,
      'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ];
    res.set('Content-Type', 'text/calendar; charset=utf-8').set('Content-Disposition', `inline; filename="${uid}.ics"`).set('Cache-Control', 'no-store').send(lines.join('\r\n') + '\r\n');
  }
  const BASE = process.env.PUBLIC_URL || 'https://felipepostolov.onrender.com';

  app.get('/r/:id.ics', ah(async (req, res) => {
    const lang = pickLang(req);
    const { data: row } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
    if (!row || row.status === 'cancelled' || DEMO_USER_IDS.has(row.host_id)) return res.status(404).send('Not found');
    const [h, m] = String(row.time || '08:00').split(':').map(n => parseInt(n, 10) || 0);
    const start = `${row.date.replace(/-/g, '')}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const endH = h + 4, endM = m + 30;
    const end = `${row.date.replace(/-/g, '')}T${String(Math.min(23, endH + Math.floor(endM / 60))).padStart(2, '0')}${String(endM % 60).padStart(2, '0')}00`;
    const where = places.fields(row.lat, row.lng, lang).placeFull;
    sendIcs(res, {
      uid: `round-${row.id}`, start, end, floating: true,
      title: lang === 'en' ? `Golf: ${row.course}` : `Golf: ${row.course}`,
      location: where ? `${row.course}, ${where}` : row.course,
      description: (lang === 'en' ? `Foursome round hosted by ${row.host_name}. ` : `Ronda de Foursome con ${row.host_name}. `) + `${BASE}/r/${row.id}`,
      url: `${BASE}/r/${encodeURIComponent(row.id)}`,
    });
  }));

  app.get('/e/:id.ics', ah(async (req, res) => {
    const lang = pickLang(req);
    const { data: row } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
    if (!row || row.status !== 'open') return res.status(404).send('Not found');
    const start = new Date(row.starts_at);
    const where = places.fields(row.lat, row.lng, lang).placeFull;
    sendIcs(res, {
      uid: `event-${row.id}`, start, end: new Date(start.getTime() + 5 * 3600e3), floating: false,
      title: row.title, location: where ? `${row.course}, ${where}` : row.course,
      description: `${row.description ? row.description + ' ' : ''}${BASE}/e/${row.id}`, url: `${BASE}/e/${row.id}`,
    });
  }));

  app.get('/r/:id', ah(async (req, res) => {
    const lang = pickLang(req);
    const t = T[lang];
    const { data: row } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
    if (!row || row.status === 'cancelled' || DEMO_USER_IDS.has(row.host_id)) {
      return res.status(404).send(page(lang, { title: 'Foursome', lines: [t.gone], appLink: null }));
    }
    const where = places.fields(row.lat, row.lng, lang).placeFull;
    const lines = [
      where || null,
      `${row.date} · ${row.time}`,
      row.open_spots > 0 ? t.spots(row.open_spots) : t.full,
      row.hcp_range ? `${t.hcp}: ${row.hcp_range}` : null,
    ].filter(Boolean);
    res.set('Cache-Control', 'no-store').send(page(lang, {
      title: `${t.round}: ${row.course}`, lines, appLink: `foursomemobile://round/${encodeURIComponent(row.id)}`,
    }));
  }));

  // Group invite: /g/<invite code>. Opening it in the app joins the group.
  app.get('/g/:code', ah(async (req, res) => {
    const lang = pickLang(req);
    const t = T[lang];
    const { data: g } = await supabase.from('groups').select('*').eq('invite_code', req.params.code).maybeSingle()
      .then(r => r, () => ({ data: null }));
    if (!g || g.removed_at || DEMO_USER_IDS.has(g.creator_id)) {
      return res.status(404).send(page(lang, { title: 'Foursome', lines: [t.groupGone], appLink: null }));
    }
    const where = places.fields(g.course_lat, g.course_lng, lang).placeFull;
    const lines = [g.home_course + (where ? ` · ${where}` : ''), g.description || null].filter(Boolean);
    res.set('Cache-Control', 'no-store').send(page(lang, {
      title: `${t.group}: ${g.name}`, lines, appLink: `foursomemobile://invite/${encodeURIComponent(g.invite_code)}`,
    }));
  }));

  app.get('/e/:id', ah(async (req, res) => {
    const lang = pickLang(req);
    const t = T[lang];
    const { data: row } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
    if (!row || row.status !== 'open' || new Date(row.starts_at) <= new Date()) {
      return res.status(404).send(page(lang, { title: 'Foursome', lines: [t.gone], appLink: null }));
    }
    const { data: regs } = await supabase.from('event_registrations')
      .select('*').eq('event_id', row.id);
    const ev = eventJson(row, regs || [], { lang });
    const lines = [
      ev.placeFull ? `${row.course} · ${ev.placeFull}` : row.course,
      whenLabel(new Date(row.starts_at), row.time_zone, lang),
      `${t.price}: ${colones(row.price_colones)}`,
      ev.spotsLeft > 0 ? t.spots(ev.spotsLeft) : t.full,
    ];
    res.set('Cache-Control', 'no-store').send(page(lang, {
      title: row.title, lines, appLink: `foursomemobile://event/${row.id}`,
    }));
  }));
}

module.exports = { registerSharePages, pickLang, APP_STORE_URL };
