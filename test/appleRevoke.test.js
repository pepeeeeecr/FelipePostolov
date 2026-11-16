// Sign in with Apple revocation: the client secret is a valid ES256 JWT, and
// without a key nothing is attempted.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

test('client secret is a signed ES256 JWT for the app', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.APPLE_SIGNIN_KEY_ID = 'ABCDE12345';
  process.env.APPLE_TEAM_ID = 'C8S8FTV64A';
  process.env.APPLE_SIGNIN_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  delete require.cache[require.resolve('../appleRevoke')];
  const apple = require('../appleRevoke');
  assert.strictEqual(apple.appleKeyStatus(), 'ok', 'reads a key stored with \\n');
  const jwt = apple._clientSecret(1700000000);
  const [h, p, sig] = jwt.split('.');
  const dec = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepStrictEqual(dec(h), { alg: 'ES256', kid: 'ABCDE12345' });
  assert.deepStrictEqual(dec(p), { iss: 'C8S8FTV64A', iat: 1700000000, exp: 1700000300, aud: 'https://appleid.apple.com', sub: 'com.felipepostolov.foursome' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.ok(ok, 'signature verifies');
});

test('without a key: no request, deletion goes ahead', async () => {
  delete process.env.APPLE_SIGNIN_KEY_ID;
  delete require.cache[require.resolve('../appleRevoke')];
  const apple = require('../appleRevoke');
  assert.deepStrictEqual(await apple.revokeWithAuthorizationCode('abc'), { revoked: false, reason: 'key missing' });
});
