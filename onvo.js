// ONVO Pay (Costa Rica): the few API calls paid events need, plus webhook
// signature checks. Docs: https://docs.onvopay.com
//
// ONVO_SECRET_KEY decides test vs live (onvo_test_… / onvo_live_…) for
// everyone. The App Review demo accounts always pay in test mode: with
// ONVO_TEST_SECRET_KEY (onvo_test_…), or with ONVO_SECRET_KEY while that is
// still a test key. A demo payment never uses a live key; with no test key
// available, demo payments are simply off.
// ONVO_WEBHOOK_SECRET / ONVO_TEST_WEBHOOK_SECRET: the whsec_… signing
// secrets of the live and test webhook endpoints (both may point at the
// same URL; a webhook signed with either is accepted).

const crypto = require('crypto');

const ONVO_API = 'https://api.onvopay.com/v1';
const SECRET_KEY = (process.env.ONVO_SECRET_KEY || '').trim();
const TEST_SECRET_KEY = (process.env.ONVO_TEST_SECRET_KEY || '').trim();
const WEBHOOK_SECRETS = [process.env.ONVO_WEBHOOK_SECRET, process.env.ONVO_TEST_WEBHOOK_SECRET].map(x => (x || '').trim()).filter(Boolean);
const WEBHOOK_SECRET = WEBHOOK_SECRETS[0] || '';

const modeOfKey = k => (k.startsWith('onvo_live_') ? 'live' : k.startsWith('onvo_test_') ? 'test' : 'unknown');
const onvoConfigured = !!SECRET_KEY;
const onvoMode = modeOfKey(SECRET_KEY);
// The demo accounts' key: always a test key, or none.
const DEMO_KEY = modeOfKey(TEST_SECRET_KEY) === 'test' ? TEST_SECRET_KEY : (onvoMode === 'test' ? SECRET_KEY : '');

if (!onvoConfigured) {
  console.warn('ONVO_SECRET_KEY not set — event payments are off until it is configured.');
} else {
  console.log(`ONVO payments configured in ${onvoMode} mode.`);
}
if (TEST_SECRET_KEY && modeOfKey(TEST_SECRET_KEY) !== 'test') console.warn('ONVO_TEST_SECRET_KEY is not an onvo_test_ key — ignored.');
console.log(DEMO_KEY ? 'ONVO: demo accounts pay in test mode.' : 'ONVO: no test key — demo account payments are off.');

// 'demo' → the test key; anything else → ONVO_SECRET_KEY.
const keyFor = mode => (mode === 'demo' ? DEMO_KEY : SECRET_KEY);
const configuredFor = mode => !!keyFor(mode);

class OnvoError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function onvoRequest(method, path, body, mode) {
  const key = keyFor(mode);
  if (!key) throw new OnvoError('ONVO is not configured', 503);
  const res = await fetch(ONVO_API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty or non-JSON */ }
  if (!res.ok) {
    const msg = data && (Array.isArray(data.message) ? data.message.join('; ') : data.message);
    throw new OnvoError(`ONVO ${method} ${path} failed (HTTP ${res.status})${msg ? ': ' + msg : ''}`, res.status, data);
  }
  return data;
}

// A one-time hosted Checkout page for one fixed charge. Amounts are in
// céntimos: ₡25,000 → 2500000.
// mode: 'demo' for the App Review accounts (test key), else omitted.
function createCheckoutSession({ amountColones, description, customerEmail, customerName, redirectUrl, cancelUrl, metadata, mode }) {
  return onvoRequest('POST', '/checkout/sessions/one-time-link', {
    lineItems: [{ quantity: 1, unitAmount: Math.round(amountColones * 100), currency: 'CRC', description }],
    customerEmail: customerEmail || undefined,
    customerName: customerName || undefined,
    redirectUrl,
    cancelUrl,
    paymentMethodTypes: ['card', 'mobile_number'],
    metadata,
  }, mode);
}

// Stops a Checkout page from being paid (used when a held spot runs out).
function expireCheckoutSession(sessionId, mode) {
  return onvoRequest('POST', `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, undefined, mode);
}

// Full refund of a successful payment. The result arrives later by webhook.
function createRefund({ paymentIntentId, amountColones, mode }) {
  return onvoRequest('POST', '/refunds', { paymentIntentId, amount: Math.round(amountColones * 100) }, mode);
}

// How a payment was made: 'card', 'mobile_number' (SINPE Móvil), … or
// null if ONVO doesn't say. Read from the payment intent (its paymentMethod,
// or by looking up its paymentMethodId).
async function paymentMethodType(paymentIntentId, mode) {
  const intent = await onvoRequest('GET', `/payment-intents/${encodeURIComponent(paymentIntentId)}`, undefined, mode);
  const pm = intent && intent.paymentMethod;
  if (pm && typeof pm === 'object' && pm.type) return String(pm.type);
  const pmId = (intent && intent.paymentMethodId) || (typeof pm === 'string' ? pm : null);
  if (!pmId) return null;
  const method = await onvoRequest('GET', `/payment-methods/${encodeURIComponent(pmId)}`, undefined, mode);
  return method && method.type ? String(method.type) : null;
}

// ONVO's answer when asked to refund something that isn't a card payment.
const isNotRefundableByApi = e => /not valid for a refund|only card payment methods/i.test(String((e && e.message) || ''));

// X-Onvo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.rawBody">
// (two v1 values while a secret is being rotated). Rejects anything older
// than 5 minutes. rawBody must be the exact bytes received.
function verifyWebhookSignature(rawBody, header, now = Date.now()) {
  return WEBHOOK_SECRETS.some(secret => verifyWith(secret, rawBody, header, now));
}
function verifyWith(WEBHOOK_SECRET, rawBody, header, now) {
  if (!WEBHOOK_SECRET || !header || !Buffer.isBuffer(rawBody)) return false;
  const parts = String(header).split(',').map(p => p.trim().split('=', 2));
  const t = Number((parts.find(([k]) => k === 't') || [])[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isSafeInteger(t) || Math.abs(Math.floor(now / 1000) - t) > 300) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.`).update(rawBody).digest();
  return sigs.some(candidate => {
    if (!/^[0-9a-f]{64}$/i.test(candidate || '')) return false;
    const got = Buffer.from(candidate, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

module.exports = {
  onvoConfigured, onvoMode, OnvoError,
  createCheckoutSession, expireCheckoutSession, createRefund, verifyWebhookSignature,
  paymentMethodType, isNotRefundableByApi,
  webhookSecretSet: WEBHOOK_SECRETS.length > 0,
  configuredFor, demoPaymentsOn: !!DEMO_KEY,
};
