const crypto = require('crypto');
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');

let secret = CONFIG.OAUTH.SESSION_SECRET;
if (!secret) {
  // Without a fixed secret, every restart logs everyone out. Fine for development only.
  secret = crypto.randomBytes(32).toString('hex');
  serverLogger.warn('SESSION_SECRET is not set; using a random secret (sessions will not survive a restart).');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/**
 * Issue a WikiVault session token for a verified wiki user.
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 * @param {{ username: string, sub: string }} user
 * @returns {{ token: string, exp: number }}
 */
function issueSessionToken(user) {
  const now = Date.now();
  const exp = now + CONFIG.OAUTH.SESSION_TTL_MS;
  const payload = b64url(JSON.stringify({ u: user.username, s: user.sub, iat: now, exp }));
  const sig = b64url(hmac(payload));
  return { token: `${payload}.${sig}`, exp };
}

/**
 * Verify a session token.
 * @param {string} token
 * @returns {{ username: string, sub: string, exp: number } | null}
 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  const expected = hmac(payload);
  let actual;
  try {
    actual = Buffer.from(sig, 'base64url');
  } catch (e) {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!data || typeof data.u !== 'string' || typeof data.exp !== 'number') return null;
  if (data.exp <= Date.now()) return null;

  return { username: data.u, sub: String(data.s), exp: data.exp };
}

module.exports = {
  issueSessionToken,
  verifySessionToken
};
