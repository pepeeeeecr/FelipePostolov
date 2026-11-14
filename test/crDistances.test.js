// From New Jersey, Valle del Sol, Cariari and Costa Rica Country Club are
// ~15 km apart in Costa Rica, so a name search for each must land on the
// Costa Rica course and show roughly the same distance (~3,480 km).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const seed = require('../data/cr-golf-courses.json');
const { makeCrCourses } = require('../crCourses');

const KM_PER_MILE = 1.609344; // same as the app's formatDistance
function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Minimal stand-in for Supabase: every query chain answers with the seed
// rows (so the table counts as already filled and load() reads them).
function fakeSupabase(rows) {
  const q = new Proxy({}, {
    get: (_, k) => k === 'then' ? r => r({ data: rows, count: rows.length, error: null }) : () => q,
  });
  return { from: () => q };
}

const NEW_JERSEY = { lat: 40.06, lng: -74.41 };
// What OpenStreetMap's name search returns for these terms today.
const OSM = {
  'Valle del Sol': [{ name: 'Valle Del Sol Golf Course', lat: 33.63967, lng: -105.85384 }],
  'Cariari': [],
  'Costa Rica Country Club': [{ name: 'Costa Rica Country Club', lat: 9.928007, lng: -84.143337 }],
};

test('Valle del Sol, Cariari and Costa Rica Country Club show the same distance from New Jersey', async () => {
  const cr = makeCrCourses({ supabase: fakeSupabase(seed.map(c => ({ ...c, country: 'CR', active: true }))), haversineMiles });
  await cr.start();
  assert.ok(cr.isReady(), 'course list loaded');

  const km = {};
  for (const term of Object.keys(OSM)) {
    const first = cr.mergeSearch(term, OSM[term])[0];
    assert.ok(first, `a result for ${term}`);
    assert.ok(cr.inCostaRica(first.lat, first.lng), `${term}: first result is in Costa Rica, got ${first.name} at ${first.lat},${first.lng}`);
    km[term] = haversineMiles(NEW_JERSEY.lat, NEW_JERSEY.lng, first.lat, first.lng) * KM_PER_MILE;
  }
  const values = Object.values(km);
  for (const v of values) assert.ok(v > 3400 && v < 3600, `about 3,480 km, got ${JSON.stringify(km)}`);
  assert.ok(Math.max(...values) - Math.min(...values) < 30, `distances agree within 30 km: ${JSON.stringify(km)}`);
});

test('an OpenStreetMap result on top of one of our courses is not listed twice', async () => {
  const cr = makeCrCourses({ supabase: fakeSupabase(seed.map(c => ({ ...c, country: 'CR', active: true }))), haversineMiles });
  await cr.start();
  const list = cr.mergeSearch('Santa Ana', [
    { name: 'Campo de Golf Santa Ana', lat: 9.948599, lng: -84.212417 },
    { name: 'Santa Ana Golf Course', lat: 35.33532, lng: -106.56086 },
  ]);
  assert.deepStrictEqual(list.map(c => c.name), ['Valle del Sol (Santa Ana)', 'Santa Ana Golf Course']);
});
