// The App Store button on every web page (home, shared rounds/events/groups,
// partner courses). Until the app is live, it says "Coming soon to the App
// Store" and isn't a link. On launch day set APP_STORE_LIVE=true in Render.

const APP_STORE_URL = 'https://apps.apple.com/app/id6831230794';
const APP_STORE_LIVE = process.env.APP_STORE_LIVE === 'true';

const TEXT = {
  es: { live: 'Descargar en el App Store', soon: 'Próximamente en el App Store' },
  en: { live: 'Download on the App Store', soon: 'Coming soon to the App Store' },
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A styled <a> when live, or a <div> saying it's coming soon.
function appStoreButton(lang, style = '') {
  const t = TEXT[lang === 'en' ? 'en' : 'es'];
  return APP_STORE_LIVE
    ? `<a href="${APP_STORE_URL}" style="${esc(style)}">${t.live}</a>`
    : `<div style="${esc(style)};opacity:.75;cursor:default" aria-disabled="true">${t.soon}</div>`;
}

module.exports = { APP_STORE_URL, APP_STORE_LIVE, appStoreButton, APP_STORE_TEXT: TEXT };
