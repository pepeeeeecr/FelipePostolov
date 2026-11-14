// Town and country for a course, shown under its name everywhere
// ("Santa Ana, Costa Rica").
//
// - Costa Rica courses: town and province from our golf_courses table.
// - Anywhere else: looked up once from OpenStreetMap (Nominatim reverse
//   geocoding), saved in course_search_cache under 'place:<lat>:<lng>' and
//   reused forever after — never looked up again on each search.
//
// fields(lat, lng) is synchronous and returns what's known right now:
//   { place: 'Town, Country', placeFull: 'Town, Province, Country' }
// or {} when nothing is known yet (the lookup is then queued in the
// background, so the next request has it). Without a town it's the country
// alone. It never returns blank strings or "undefined".

const { AsyncLocalStorage } = require('async_hooks');

const langStore = new AsyncLocalStorage();
const LOOKUP_EVERY_MS = 1100;   // Nominatim allows 1 request/second in all; searches go first (nominatimBusy)
const RETRY_FAILED_MS = 60 * 60 * 1000;
const MAX_PENDING = 500;

let deps = null;                // { supabase, nominatimFetch, crCourses, nominatimBusy }
const known = new Map();        // key -> { town, province, cc }
const pending = new Set();      // keys waiting for a lookup
const failedAt = new Map();     // key -> time of the last failed lookup
let worker = null;

const keyFor = (lat, lng) => `place:${Number(lat).toFixed(2)}:${Number(lng).toFixed(2)}`;
const clean = s => (typeof s === 'string' && s.trim() && s.trim() !== 'undefined' ? s.trim() : null);

// Express middleware: remembers the request's language ('es' | 'en') so
// country names come out in it ("Estados Unidos" / "United States").
function languageMiddleware(pickLang) {
  return (req, res, next) => langStore.run(pickLang(req), next);
}

const countryNamers = {};
function countryName(cc, lang) {
  if (!cc) return null;
  try {
    countryNamers[lang] = countryNamers[lang] || new Intl.DisplayNames([lang], { type: 'region' });
    return clean(countryNamers[lang].of(cc.toUpperCase()));
  } catch (e) {
    return null;
  }
}

function label(p, lang) {
  const country = countryName(p.cc, lang);
  const town = clean(p.town);
  const province = clean(p.province);
  if (!country) return town ? { place: town, placeFull: province && province !== town ? `${town}, ${province}` : town } : {};
  if (!town) return { place: country, placeFull: province ? `${province}, ${country}` : country };
  return {
    place: `${town}, ${country}`,
    placeFull: province && province !== town ? `${town}, ${province}, ${country}` : `${town}, ${country}`,
  };
}

function lookupFor(lat, lng) {
  // Costa Rica: our own table already knows the town and province.
  const cr = deps.crCourses && deps.crCourses.nearest(lat, lng, 1.25);
  if (cr) return { town: cr.town, province: cr.province, cc: 'cr' };
  return known.get(keyFor(lat, lng)) || null;
}

function fields(lat, lng, lang = langStore.getStore() || 'es') {
  if (!deps || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || lat === null || lng === null) return {};
  const p = lookupFor(Number(lat), Number(lng));
  if (p) return label(p, lang);
  queue(Number(lat), Number(lng));
  return {};
}

// For a list: adds place/placeFull to every item that has lat/lng.
function attach(list, latKey = 'lat', lngKey = 'lng') {
  return (list || []).map(item => (item ? { ...item, ...fields(item[latKey], item[lngKey]) } : item));
}

function queue(lat, lng) {
  const key = keyFor(lat, lng);
  if (known.has(key) || pending.has(key) || pending.size >= MAX_PENDING) return;
  if (Date.now() - (failedAt.get(key) || 0) < RETRY_FAILED_MS) return;
  pending.add(key);
  if (!worker) {
    worker = setInterval(lookupNext, LOOKUP_EVERY_MS);
    worker.unref();
  }
}

let busy = false;
async function lookupNext() {
  if (busy || (deps.nominatimBusy && deps.nominatimBusy())) return;
  const key = pending.values().next().value;
  if (!key) { clearInterval(worker); worker = null; return; }
  busy = true;
  const [, lat, lng] = key.split(':');
  try {
    const res = await deps.nominatimFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lng}`, { background: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = (await res.json()).address || {};
    const p = {
      town: clean(a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || a.county),
      province: clean(a.state || a.province || a.region),
      cc: clean(a.country_code),
    };
    if (!p.cc && !p.town) throw new Error('no address here');
    known.set(key, p);
    const { error } = await deps.supabase.from('course_search_cache')
      .upsert({ key, data: p, complete: true, updated_at: new Date().toISOString() });
    if (error) console.warn('Course place save failed:', error.message);
  } catch (e) {
    failedAt.set(key, Date.now());
    console.warn('Course place lookup failed for', key, e.message);
  } finally {
    pending.delete(key);
    busy = false;
  }
}

// True while any item in the list is waiting for its lookup.
function pendingAny(list) {
  return (list || []).some(c => c && c.lat != null && c.lng != null && pending.has(keyFor(c.lat, c.lng)));
}

// At startup: every place looked up before (they don't go stale).
async function init(d) {
  deps = d;
  let from = 0;
  for (;;) {
    const { data, error } = await d.supabase.from('course_search_cache')
      .select('key, data').like('key', 'place:%').range(from, from + 999);
    if (error) { console.warn('Saved course places unavailable:', error.message); return; }
    for (const row of data || []) known.set(row.key, row.data);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  console.log(`Course places: ${known.size} restored from the database.`);
}

module.exports = { init, fields, attach, label, pendingAny, languageMiddleware, keyFor, _known: known, _pending: pending };
