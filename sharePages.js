// Shared links for rounds and events: /r/:id and /e/:id.
//
// With the app installed (from the next build on, via Universal Links —
// see the apple-app-site-association route below) the link opens the app
// straight to that round or event. Otherwise it's this small page with the
// details, an "Open in Foursome" button and a "Get the app" button.

const { whenLabel } = require('./events');

const APP_STORE_URL = 'https://apps.apple.com/app/id6831230794';
const APPLE_APP_ID = 'C8S8FTV64A.com.felipepostolov.foursome'; // Team ID + bundle ID

// Spanish unless the browser asks for English first.
function pickLang(req) {
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  const first = al.split(',')[0].trim();
  return first.startsWith('en') ? 'en' : 'es';
}

const T = {
  es: {
    round: 'Ronda abierta', event: 'Evento Foursome', spots: n => `${n} ${n === 1 ? 'espacio libre' : 'espacios libres'}`,
    full: 'Lleno', hcp: 'Hándicap', open: 'Abrir en Foursome', get: 'Descargar la app',
    gone: 'Esta ronda o evento ya no está disponible.', price: 'Precio',
    blurb: 'Foursome te ayuda a encontrar con quién jugar golf.',
  },
  en: {
    round: 'Open round', event: 'Foursome event', spots: n => `${n} ${n === 1 ? 'spot' : 'spots'} open`,
    full: 'Full', hcp: 'Handicap', open: 'Open in Foursome', get: 'Get the app',
    gone: 'This round or event is no longer available.', price: 'Price',
    blurb: 'Foursome helps golfers find people to play with.',
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
<a href="${APP_STORE_URL}" style="display:block;margin-top:10px;border:1px solid #2E5E3A;color:#2E5E3A;text-decoration:none;padding:13px;border-radius:12px;font-weight:600;">${t.get}</a>
<p style="margin-top:22px;font-size:13px;opacity:.6;">${t.blurb}</p>
</div></body></html>`;
}

function registerSharePages(app, { supabase, ah, DEMO_USER_IDS, eventJson }) {
  // Lets iOS open /r/… and /e/… links in the app (Universal Links).
  app.get('/.well-known/apple-app-site-association', (req, res) => {
    res.type('application/json').send(JSON.stringify({
      applinks: { apps: [], details: [{ appID: APPLE_APP_ID, paths: ['/r/*', '/e/*'] }] },
    }));
  });

  app.get('/r/:id', ah(async (req, res) => {
    const lang = pickLang(req);
    const t = T[lang];
    const { data: row } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
    if (!row || row.status === 'cancelled' || DEMO_USER_IDS.has(row.host_id)) {
      return res.status(404).send(page(lang, { title: 'Foursome', lines: [t.gone], appLink: null }));
    }
    const lines = [
      `${row.date} · ${row.time}`,
      row.open_spots > 0 ? t.spots(row.open_spots) : t.full,
      row.hcp_range ? `${t.hcp}: ${row.hcp_range}` : null,
    ].filter(Boolean);
    res.set('Cache-Control', 'no-store').send(page(lang, {
      title: `${t.round}: ${row.course}`, lines, appLink: `foursomemobile://round/${encodeURIComponent(row.id)}`,
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
      .select('event_id, user_id, user_name, status, hold_expires_at, checkout_url, created_at').eq('event_id', row.id);
    const ev = eventJson(row, regs || []);
    const lines = [
      row.course,
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
