// Town and country under course names: Costa Rica from our table, elsewhere
// looked up once and reused, country alone when there's no town, and never
// a blank or "undefined".
const test = require('node:test');
const assert = require('node:assert');
const seed = require('../data/cr-golf-courses.json');
const { makeCrCourses } = require('../crCourses');
const places = require('../places');

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const saved = [];
function fakeSupabase(rows) {
  const q = new Proxy({}, {
    get: (_, k) => k === 'then' ? r => r({ data: rows, count: rows.length, error: null })
      : k === 'upsert' ? row => { saved.push(row); return q; } : () => q,
  });
  return { from: () => q };
}
let lookups = 0;
const ADDRESSES = {
  '33.64:-105.85': { town: 'Carrizozo', county: 'Lincoln County', state: 'New Mexico', country_code: 'us' },
  '40.00:-30.00': { country_code: 'pt' },  // no town: country only
};
async function nominatimFetch(url) {
  lookups++;
  const [, lat, lng] = url.match(/lat=([-\d.]+)&lon=([-\d.]+)/);
  const address = ADDRESSES[`${lat}:${lng}`];
  return { ok: true, json: async () => (address ? { address } : { error: 'Unable to geocode' }) };
}

test('course places', async () => {
  const cr = makeCrCourses({ supabase: fakeSupabase(seed.map(c => ({ ...c, country: 'CR', active: true }))), haversineMiles });
  await cr.start();
  await places.init({ supabase: fakeSupabase([]), nominatimFetch, crCourses: cr });

  // Costa Rica: from our table, no lookup.
  assert.deepStrictEqual(places.fields(9.948599, -84.212417, 'en'), { place: 'Santa Ana, Costa Rica', placeFull: 'Santa Ana, San José, Costa Rica' });
  assert.strictEqual(places.fields(9.971757, -84.157537, 'es').place, 'La Asunción, Costa Rica');

  // Elsewhere: nothing yet, looked up in the background, then reused.
  assert.deepStrictEqual(places.fields(33.63967, -105.85384, 'en'), {});
  assert.deepStrictEqual(places.fields(40.0, -30.0, 'en'), {});
  assert.deepStrictEqual(places.fields(10.0, 10.0, 'en'), {});   // lookup will find nothing
  await new Promise(r => setTimeout(r, 3000 * 3 + 500));
  assert.strictEqual(lookups, 3);
  assert.deepStrictEqual(places.fields(33.63967, -105.85384, 'en'), { place: 'Carrizozo, United States', placeFull: 'Carrizozo, New Mexico, United States' });
  assert.strictEqual(places.fields(33.64, -105.85, 'es').place, 'Carrizozo, Estados Unidos');
  assert.deepStrictEqual(places.fields(40.0, -30.0, 'en'), { place: 'Portugal', placeFull: 'Portugal' });
  assert.ok(saved.some(r => r.key === 'place:33.64:-105.85' && r.data.town === 'Carrizozo'), 'saved in the database');
  places.fields(33.63967, -105.85384, 'en');
  places.fields(10.0, 10.0, 'en');   // failed recently: not retried yet
  await new Promise(r => setTimeout(r, 3500));
  assert.strictEqual(lookups, 3, 'never looked up again');

  // No location, or garbage: nothing at all rather than blanks.
  for (const [lat, lng] of [[null, null], [undefined, undefined], ['x', 'y']]) assert.deepStrictEqual(places.fields(lat, lng, 'en'), {});
  for (const p of [{ cc: 'us', town: 'undefined' }, { cc: 'us', town: '  ' }, { town: null, cc: null }]) {
    for (const v of Object.values(places.label(p, 'en'))) assert.ok(v && !/undefined/.test(v), JSON.stringify(p));
  }
  assert.deepStrictEqual(places.label({ cc: 'us', town: 'undefined' }, 'en'), { place: 'United States', placeFull: 'United States' });
});
