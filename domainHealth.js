// Is the public domain (PUBLIC_URL, foursomecr.com) actually reachable?
// Checked every 2 minutes from the server itself. While it isn't, links the
// server hands out (ONVO's return page) use the onrender address instead,
// and the onrender address stops forwarding web pages to the domain.

const ONRENDER = 'https://felipepostolov.onrender.com';
const CHECK_MS = 2 * 60 * 1000;
const configured = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
let healthy = true; // assume fine until a check says otherwise
let lastChange = null;

async function check() {
  if (!configured || configured.includes('onrender.com')) return;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(configured + '/health', { signal: ctrl.signal });
    clearTimeout(timer);
    ok = res.ok;
  } catch (e) { ok = false; }
  if (ok !== healthy) {
    healthy = ok;
    lastChange = new Date().toISOString();
    console[ok ? 'log' : 'warn'](`Public domain ${configured} is ${ok ? 'reachable again' : 'NOT reachable'} — links use ${ok ? configured : ONRENDER}.`);
  }
}

function start() {
  check();
  setInterval(check, CHECK_MS).unref();
}

// The address to put in links right now.
const publicBase = () => (configured && healthy ? configured : ONRENDER);
const domainHealthy = () => healthy;
const status = () => ({ domain: configured || null, reachable: healthy, since: lastChange });

module.exports = { start, publicBase, domainHealthy, status, ONRENDER };
