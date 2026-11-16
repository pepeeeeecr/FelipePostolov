// Sign in with Apple: when someone who signed in with Apple deletes their
// account, Apple requires the app to revoke its access. The app gets a fresh
// authorization code (Apple asks once more) and sends it with the deletion;
// here it's exchanged for a token, which is then revoked.
//
// Needs APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY (the .p8 contents) and
// APPLE_TEAM_ID in Render. Their values are never logged.

const crypto = require('crypto');

const CLIENT_ID = 'com.felipepostolov.foursome'; // the app's bundle id
const KEY_ID = (process.env.APPLE_SIGNIN_KEY_ID || '').trim();
const TEAM_ID = (process.env.APPLE_TEAM_ID || '').trim();
// Render can store the .p8 with real line breaks or with \n; both work.
const PRIVATE_KEY = (process.env.APPLE_SIGNIN_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

function keyStatus() {
  if (!KEY_ID || !TEAM_ID || !PRIVATE_KEY) return 'missing';
  try { crypto.createPrivateKey(PRIVATE_KEY); return 'ok'; } catch (e) { return 'unreadable'; }
}
const STATUS = keyStatus();
if (STATUS === 'ok') console.log(`Sign in with Apple: key present and readable (key id ${KEY_ID.length} chars, team ${TEAM_ID.length} chars).`);
else console.warn(`Sign in with Apple: revoking on account deletion is OFF — the key is ${STATUS}. Check APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY and APPLE_TEAM_ID in Render.`);

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// The client secret Apple wants: a short-lived ES256 JWT signed with the key.
function clientSecret(now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID }));
  const payload = b64url(JSON.stringify({ iss: TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: CLIENT_ID }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: PRIVATE_KEY, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

async function applePost(path, params) {
  const res = await fetch(`https://appleid.apple.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apple ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Exchanges the code and revokes. Never throws: account deletion goes ahead
// either way; returns what happened, for the log.
async function revokeWithAuthorizationCode(code) {
  if (STATUS !== 'ok') return { revoked: false, reason: `key ${STATUS}` };
  if (!code) return { revoked: false, reason: 'no code' };
  try {
    const secret = clientSecret();
    const tokens = await applePost('/auth/token', { client_id: CLIENT_ID, client_secret: secret, code, grant_type: 'authorization_code' });
    const token = tokens.refresh_token || tokens.access_token;
    if (!token) return { revoked: false, reason: 'no token from Apple' };
    await applePost('/auth/revoke', { client_id: CLIENT_ID, client_secret: secret, token, token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token' });
    return { revoked: true };
  } catch (e) {
    return { revoked: false, reason: e.message };
  }
}

module.exports = { revokeWithAuthorizationCode, appleKeyStatus: () => STATUS, _clientSecret: clientSecret };
