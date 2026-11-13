// Costa Rica golf courses from our own database (golf_courses table), so
// nearby searches in Costa Rica are instant and complete instead of waiting
// on OpenStreetMap's busy servers. Loaded into memory at startup and
// reloaded every hour; refreshed from OpenStreetMap once a month.
//
// First run: if the table is empty, it's filled from data/cr-golf-courses.json
// (OpenStreetMap + hand-added courses such as La Iguana at Los Sueños).

const path = require('path');
const fs = require('fs');

// Costa Rica's bounding box. Points just over the border in Nicaragua or
// Panama also land here; they're shown Costa Rica courses, which is fine.
const CR_BOUNDS = { minLat: 8.0, maxLat: 11.25, minLng: -86.0, maxLng: -82.5 };
const RELOAD_MS = 60 * 60 * 1000;
const OSM_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const SEED_FILE = path.join(__dirname, 'data', 'cr-golf-courses.json');

function inCostaRica(lat, lng) {
  return lat >= CR_BOUNDS.minLat && lat <= CR_BOUNDS.maxLat && lng >= CR_BOUNDS.minLng && lng <= CR_BOUNDS.maxLng;
}

// "Cariari", "cariarí" and "CARIARI" all match.
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function makeCrCourses({ supabase, haversineMiles, overpassQuery, overpassServers }) {
  let courses = [];   // [{ name, lat, lng, town, province }]
  let ready = false;  // table exists and has rows

  async function seedIfEmpty() {
    const { count, error } = await supabase.from('golf_courses').select('id', { count: 'exact', head: true });
    if (error) throw error;
    if ((count || 0) > 0) return;
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const rows = seed.map(c => ({
      name: c.name, lat: c.lat, lng: c.lng, town: c.town || null, province: c.province || null,
      holes: c.holes ? parseInt(c.holes, 10) || null : null, website: c.website || null,
      osm_id: c.osm_id || null, source: c.source || 'osm', country: 'CR',
    }));
    const { error: insertError } = await supabase.from('golf_courses').insert(rows);
    if (insertError) throw insertError;
    console.log(`Costa Rica courses: seeded ${rows.length} courses from ${path.basename(SEED_FILE)}.`);
  }

  async function load() {
    const { data, error } = await supabase.from('golf_courses')
      .select('name, lat, lng, town, province').eq('country', 'CR').eq('active', true);
    if (error) throw error;
    courses = data || [];
    ready = courses.length > 0;
  }

  // Monthly: pull Costa Rica's courses from OpenStreetMap and add or update
  // them. Rows marked source = 'manual' are never touched, and nothing is
  // deleted — a course that disappears from OpenStreetMap stays until
  // someone sets active = false.
  async function refreshFromOsmIfDue() {
    const { data: newest } = await supabase.from('golf_courses').select('updated_at')
      .eq('source', 'osm').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (newest && Date.now() - new Date(newest.updated_at).getTime() < OSM_REFRESH_MS) return;
    const query = `[out:json][timeout:120];nwr["leisure"="golf_course"](${CR_BOUNDS.minLat},${CR_BOUNDS.minLng},${CR_BOUNDS.maxLat},${CR_BOUNDS.maxLng});out center tags;`;
    const result = await overpassQuery(query, overpassServers);
    const { data: manual } = await supabase.from('golf_courses').select('osm_id').eq('source', 'manual').not('osm_id', 'is', null);
    const manualIds = new Set((manual || []).map(r => r.osm_id));
    const known = new Set(courses.map(c => fold(c.name)));
    let added = 0;
    for (const e of result.elements || []) {
      const lat = e.lat ?? (e.center && e.center.lat);
      const lng = e.lon ?? (e.center && e.center.lon);
      const name = e.tags && (e.tags.name || e.tags['name:es'] || e.tags['name:en']);
      const osmId = `${e.type}/${e.id}`;
      if (lat == null || !name || manualIds.has(osmId)) continue;
      // Only courses actually in Costa Rica: new ones near the border are
      // skipped rather than guessed; existing rows are updated in place.
      const { data: existing } = await supabase.from('golf_courses').select('id').eq('osm_id', osmId).maybeSingle();
      if (existing) {
        await supabase.from('golf_courses').update({ name, lat, lng, updated_at: new Date().toISOString() }).eq('id', existing.id);
      } else if (!known.has(fold(name)) && inCostaRica(lat, lng) && lat > 8.03 && lng < -82.56) {
        await supabase.from('golf_courses').insert({ name, lat, lng, osm_id: osmId, source: 'osm', country: 'CR' });
        added++;
      }
    }
    console.log(`Costa Rica courses: OpenStreetMap refresh done, ${added} new.`);
    await load();
  }

  async function start() {
    try {
      await seedIfEmpty();
      await load();
      console.log(`Costa Rica courses: ${courses.length} loaded from the database.`);
    } catch (e) {
      // Most likely supabase-golf-courses.sql hasn't been run yet: keep
      // using OpenStreetMap live, exactly as before.
      console.warn('Costa Rica courses unavailable — using OpenStreetMap live:', e.message);
      ready = false;
    }
    // Hourly reload — and until the table exists (SQL not run yet), keep
    // trying to fill it, so it starts working without a redeploy.
    setInterval(() => {
      (ready ? load() : seedIfEmpty().then(load).then(() => console.log(`Costa Rica courses: ${courses.length} loaded from the database.`)))
        .catch(() => {});
    }, RELOAD_MS).unref();
    const refresh = () => refreshFromOsmIfDue().catch(e => console.warn('Costa Rica OpenStreetMap refresh failed:', e.message));
    setTimeout(refresh, 5 * 60 * 1000).unref();
    setInterval(refresh, 24 * 60 * 60 * 1000).unref();
  }

  // Courses within radiusMiles of the point, closest first — or null when
  // this isn't a Costa Rica search (or the table isn't ready), so the caller
  // falls back to OpenStreetMap.
  function nearby(lat, lng, radiusMiles) {
    if (!ready || !inCostaRica(lat, lng)) return null;
    return courses
      .map(c => ({ name: c.name, lat: c.lat, lng: c.lng, town: c.town, distanceMiles: Math.round(haversineMiles(lat, lng, c.lat, c.lng) * 10) / 10 }))
      .filter(c => c.distanceMiles <= radiusMiles)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
  }

  // Costa Rica courses whose name (or town) contains the search term.
  function search(term) {
    if (!ready) return [];
    const q = fold(term).replace(/\b(golf|club|course|campo|de|country)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.length < 3) return [];
    return courses
      .filter(c => fold(c.name).includes(q) || fold(c.town).includes(q))
      .map(c => ({ name: c.name, lat: c.lat, lng: c.lng, town: c.town }));
  }

  return { start, nearby, search, inCostaRica, isReady: () => ready, count: () => courses.length };
}

module.exports = { makeCrCourses, inCostaRica };
