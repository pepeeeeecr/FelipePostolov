// A small in-memory stand-in for the Supabase client: enough of select /
// eq / neq / in / gte / gt / lte / lt / or / like / order / limit / range /
// maybeSingle / single, plus insert (with unique keys), update and upsert.
function makeFakeSupabase(tables, { unique = {}, missingColumns = {} } = {}) {
  let nextId = 1000;
  function query(name) {
    const rows = () => (tables[name] = tables[name] || []);
    const filters = [];
    let op = 'select', payload = null, opts = {}, single = null, limitN = null;
    const q = {
      select(cols, o) { if (op === 'select') { opts = o || {}; if ((missingColumns[name] || []).some(c => String(cols).includes(c))) opts.missing = true; } return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      neq(k, v) { filters.push(r => r[k] !== v); return q; },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return q; },
      gte(k, v) { filters.push(r => r[k] >= v); return q; },
      gt(k, v) { filters.push(r => r[k] > v); return q; },
      lte(k, v) { filters.push(r => r[k] <= v); return q; },
      lt(k, v) { filters.push(r => r[k] < v); return q; },
      like(k, v) { const re = new RegExp('^' + v.replace(/%/g, '.*') + '$'); filters.push(r => re.test(r[k])); return q; },
      is(k, v) { if ((missingColumns[name] || []).includes(k)) opts.missing = true;
         filters.push(r => (r[k] ?? null) === v); return q; },
      not() { return q; },
      or(expr) {
        const parts = expr.split(',').map(p => p.split('.eq.'));
        filters.push(r => parts.some(([k, v]) => String(r[k]) === v));
        return q;
      },
      order() { return q; },
      limit(n) { limitN = n; return q; },
      range() { return q; },
      maybeSingle() { single = 'maybe'; return q; },
      single() { single = 'one'; return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      upsert(p) { op = 'upsert'; payload = p; return q; },
      delete() { op = 'delete'; return q; },
      then(resolve, reject) {
        try { resolve(run()); } catch (e) { reject(e); }
      },
    };
    function run() {
      if (opts.missing) return { data: null, error: { message: 'column does not exist' } };
      const match = rows().filter(r => filters.every(f => f(r)));
      if (op === 'insert') {
        for (const p of [].concat(payload)) {
          const keys = unique[name] || [];
          if (keys.length && rows().some(r => keys.every(k => r[k] === p[k]))) return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
          rows().push({ id: nextId++, sent_at: new Date().toISOString(), created_at: new Date().toISOString(), ...p });
        }
        return { data: payload, error: null };
      }
      if (op === 'upsert') {
        const p = payload; const i = rows().findIndex(r => r.key === p.key);
        if (i >= 0) rows()[i] = { ...rows()[i], ...p }; else rows().push({ ...p });
        return { data: p, error: null };
      }
      if (op === 'update') { match.forEach(r => Object.assign(r, payload)); return { data: match, error: null }; }
      if (op === 'delete') { tables[name] = rows().filter(r => !match.includes(r)); return { data: null, error: null }; }
      const data = limitN != null ? match.slice(0, limitN) : match;
      if (opts.head) return { data: null, count: match.length, error: null };
      if (single) return { data: data[0] || null, error: single === 'one' && !data[0] ? { message: 'no rows' } : null };
      return { data, count: match.length, error: null };
    }
    return q;
  }
  // Storage: files kept in memory per bucket.
  const files = {};
  const storage = {
    from(bucket) {
      files[bucket] = files[bucket] || new Map();
      return {
        async upload(path, buf) { if (bucket === 'missing') return { error: { message: 'Bucket not found' } }; files[bucket].set(path, buf); return { data: { path }, error: null }; },
        getPublicUrl(path) { return { data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${path}` } }; },
        async remove(paths) { paths.forEach(p => files[bucket].delete(p)); return { error: null }; },
      };
    },
    _files: files,
  };
  return { from: query, storage };
}
module.exports = { makeFakeSupabase };
