// App Review demo: payments always in ONVO test mode (never a live key),
// and the demo event stays about a week out.
const test = require('node:test');
const assert = require('node:assert');

function loadOnvo(env) {
  for (const k of ['ONVO_SECRET_KEY', 'ONVO_TEST_SECRET_KEY', 'ONVO_WEBHOOK_SECRET', 'ONVO_TEST_WEBHOOK_SECRET']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../onvo')];
  return require('../onvo');
}

test('demo accounts: test key only; real users: the main key', () => {
  let o = loadOnvo({ ONVO_SECRET_KEY: 'onvo_test_abc' });
  assert.strictEqual(o.configuredFor('demo'), true, 'today: the main key is a test key, demo uses it');
  assert.strictEqual(o.configuredFor(undefined), true);

  o = loadOnvo({ ONVO_SECRET_KEY: 'onvo_live_abc' });
  assert.strictEqual(o.configuredFor(undefined), true, 'real users: live');
  assert.strictEqual(o.configuredFor('demo'), false, 'live key only: demo payments off, never live');

  o = loadOnvo({ ONVO_SECRET_KEY: 'onvo_live_abc', ONVO_TEST_SECRET_KEY: 'onvo_test_xyz' });
  assert.strictEqual(o.configuredFor('demo'), true, 'live + test key: demo uses the test key');

  o = loadOnvo({ ONVO_SECRET_KEY: 'onvo_live_abc', ONVO_TEST_SECRET_KEY: 'onvo_live_oops' });
  assert.strictEqual(o.configuredFor('demo'), false, 'a live key in the test slot is ignored');
});

test('demo requests carry the test key; real ones the live key', async () => {
  const o = loadOnvo({ ONVO_SECRET_KEY: 'onvo_live_abc', ONVO_TEST_SECRET_KEY: 'onvo_test_xyz' });
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { seen.push(opts.headers.Authorization); return { ok: true, json: async () => ({ id: 'rf' }) }; };
  try {
    await o.createRefund({ paymentIntentId: 'pi', amountColones: 100, mode: 'demo' });
    await o.createRefund({ paymentIntentId: 'pi', amountColones: 100 });
  } finally { global.fetch = realFetch; }
  assert.deepStrictEqual(seen, ['Bearer onvo_test_xyz', 'Bearer onvo_live_abc']);
});

test('webhooks signed with either secret are accepted', () => {
  const crypto = require('crypto');
  const o = loadOnvo({ ONVO_SECRET_KEY: 'onvo_live_abc', ONVO_WEBHOOK_SECRET: 'whsec_live', ONVO_TEST_WEBHOOK_SECRET: 'whsec_test' });
  const body = Buffer.from('{"id":"evt"}');
  const t = Math.floor(Date.now() / 1000);
  const sign = secret => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
  assert.strictEqual(o.verifyWebhookSignature(body, sign('whsec_live')), true);
  assert.strictEqual(o.verifyWebhookSignature(body, sign('whsec_test')), true);
  assert.strictEqual(o.verifyWebhookSignature(body, sign('whsec_other')), false);
});

test('demo event: kept about a week out, same weekday and time', () => {
  const { nextDemoStart } = require('../events');
  const now = Date.parse('2026-11-17T12:00:00Z');
  assert.strictEqual(nextDemoStart(Date.parse('2026-11-24T14:00:00Z'), now), null, '7 days out: left alone');
  assert.strictEqual(nextDemoStart(Date.parse('2026-11-19T14:00:00Z'), now), '2026-11-26T14:00:00.000Z', '2 days out: a week later');
  assert.strictEqual(nextDemoStart(Date.parse('2026-10-01T14:00:00Z'), now), '2026-11-26T14:00:00.000Z', 'long past: whole weeks, same weekday and time');
});
