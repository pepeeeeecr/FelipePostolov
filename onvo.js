// ONVO Pay (Costa Rica): the few API calls paid events need, plus webhook
// signature checks. Docs: https://docs.onvopay.com
//
// ONVO_SECRET_KEY decides test vs live (onvo_test_… / onvo_live_…).
// ONVO_WEBHOOK_SECRET is the endpoint's whsec_… signing secret.

const crypto = require('crypto');

const ONVO_API = 'https://api.onvopay.com/v1';
const SECRET_KEY = process.env.ONVO_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.ONVO_WEBHOOK_SECRET || '';

const onvoConfigured = !!SECRET_KEY;
const onvoMode = SECRET_KEY.startsWith('onvo_live_') ? 'live' : SECRET_KEY.startsWith('onvo_test_') ? 'test' : 'unknown';

if (!onvoConfigured) {
  console.warn('ONVO_SECRET_KEY not set — event payments are off until it is configured.');
} else {
  console.log(`ONVO payments configured in ${onvoMode} mode.`);
}

class OnvoError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function onvoRequest(method, path, body) {
  if (!onvoConfigured) throw new OnvoError('ONVO is not configured', 503);
  const res = await fetch(ONVO_API + path, {
    method,
    headers: { Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json' },
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
function createCheckoutSession({ amountColones, description, customerEmail, customerName, redirectUrl, cancelUrl, metadata }) {
  return onvoRequest('POST', '/checkout/sessions/one-time-link', {
    lineItems: [{ quantity: 1, unitAmount: Math.round(amountColones * 100), currency: 'CRC', description }],
    customerEmail: customerEmail || undefined,
    customerName: customerName || undefined,
    redirectUrl,
    cancelUrl,
    paymentMethodTypes: ['card', 'mobile_number'],
    metadata,
  });
}

// Stops a Checkout page from being paid (used when a held spot runs out).
function expireCheckoutSession(sessionId) {
  return onvoRequest('POST', `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`);
}

// Full refund of a successful payment. The result arrives later by webhook.
function createRefund({ paymentIntentId, amountColones }) {
  return onvoRequest('POST', '/refunds', { paymentIntentId, amount: Math.round(amountColones * 100) });
}

// X-Onvo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.rawBody">
// (two v1 values while a secret is being rotated). Rejects anything older
// than 5 minutes. rawBody must be the exact bytes received.
function verifyWebhookSignature(rawBody, header, now = Date.now()) {
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
  webhookSecretSet: !!WEBHOOK_SECRET,
};
