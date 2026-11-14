const crypto = require('crypto');
const axios = require('axios');
const CONFIG = require('../config');

const HTTP_TIMEOUT_MS = 15000;
const JWT_CLOCK_SKEW_SEC = 120;

/**
 * RFC 3986 percent-encoding as required by OAuth 1.0a.
 * @param {string} value
 * @returns {string}
 */
function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Build the OAuth 1.0a HMAC-SHA1 signature.
 * @param {string} method - HTTP method
 * @param {string} baseUrl - URL without query string
 * @param {Record<string, string>} params - query params + oauth_* params (without oauth_signature)
 * @param {string} consumerSecret
 * @param {string} [tokenSecret]
 * @returns {string} base64 signature
 */
function sign(method, baseUrl, params, consumerSecret, tokenSecret = '') {
  const normalized = Object.keys(params)
    .map((k) => [percentEncode(k), percentEncode(params[k])])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join('&');
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

/**
 * Send a signed GET request to Special:OAuth/<action>.
 * @param {string} action - initiate | token | identify
 * @param {{ token?: string, tokenSecret?: string, extraOAuth?: Record<string, string> }} opts
 * @returns {Promise<{ body: string, nonce: string }>}
 */
async function signedOAuthGet(action, { token, tokenSecret = '', extraOAuth = {} } = {}) {
  const { CONSUMER_KEY, CONSUMER_SECRET, INDEX_URL, USER_AGENT } = CONFIG.OAUTH;
  const query = { title: `Special:OAuth/${action}`, format: 'json' };
  const nonce = crypto.randomBytes(16).toString('hex');
  const oauthParams = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...extraOAuth
  };
  if (token) oauthParams.oauth_token = token;

  oauthParams.oauth_signature = sign('GET', INDEX_URL, { ...query, ...oauthParams }, CONSUMER_SECRET, tokenSecret);

  const authHeader = 'OAuth ' + Object.keys(oauthParams)
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  const res = await axios.get(INDEX_URL, {
    params: query,
    headers: { Authorization: authHeader, 'User-Agent': USER_AGENT },
    timeout: HTTP_TIMEOUT_MS,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true
  });

  const body = typeof res.data === 'string' ? res.data.trim() : '';
  if (res.status !== 200) {
    throw new Error(`Special:OAuth/${action} returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return { body, nonce };
}

/**
 * Parse a token response (JSON {key, secret} or form-encoded oauth_token=...).
 * @param {string} body
 * @param {string} action
 * @returns {{ key: string, secret: string }}
 */
function parseTokenResponse(body, action) {
  let key, secret;
  try {
    const json = JSON.parse(body);
    if (json.error) throw new Error(`Special:OAuth/${action} error: ${json.error}${json.message ? ` (${json.message})` : ''}`);
    key = json.key || json.oauth_token;
    secret = json.secret || json.oauth_token_secret;
  } catch (e) {
    if (e instanceof SyntaxError) {
      const qs = new URLSearchParams(body);
      key = qs.get('oauth_token');
      secret = qs.get('oauth_token_secret');
    } else {
      throw e;
    }
  }
  if (!key || !secret) {
    throw new Error(`Special:OAuth/${action}: unexpected response: ${body.slice(0, 300)}`);
  }
  return { key, secret };
}

/**
 * Step 1: obtain a request token.
 * @returns {Promise<{ key: string, secret: string }>}
 */
async function initiate() {
  const { body } = await signedOAuthGet('initiate', {
    extraOAuth: { oauth_callback: CONFIG.OAUTH.CALLBACK_URL }
  });
  return parseTokenResponse(body, 'initiate');
}

/**
 * URL to send the user to for approval.
 * @param {string} requestKey
 * @returns {string}
 */
function getAuthorizeUrl(requestKey) {
  const url = new URL(CONFIG.OAUTH.AUTHORIZE_URL);
  url.searchParams.set('oauth_token', requestKey);
  url.searchParams.set('oauth_consumer_key', CONFIG.OAUTH.CONSUMER_KEY);
  return url.toString();
}

/**
 * Step 3: exchange the approved request token for an access token.
 * @param {string} requestKey
 * @param {string} requestSecret
 * @param {string} verifier
 * @returns {Promise<{ key: string, secret: string }>}
 */
async function exchangeToken(requestKey, requestSecret, verifier) {
  const { body } = await signedOAuthGet('token', {
    token: requestKey,
    tokenSecret: requestSecret,
    extraOAuth: { oauth_verifier: verifier }
  });
  return parseTokenResponse(body, 'token');
}

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Step 4: ask the wiki who the user is, and verify the returned JWT.
 * @param {string} accessKey
 * @param {string} accessSecret
 * @returns {Promise<{ username: string, sub: string, blocked: boolean, groups: string[] }>}
 */
async function identify(accessKey, accessSecret) {
  const { CONSUMER_KEY, CONSUMER_SECRET, INDEX_URL, IDENTIFY_ISSUER } = CONFIG.OAUTH;
  const { body, nonce } = await signedOAuthGet('identify', { token: accessKey, tokenSecret: accessSecret });

  // The JWT may come back JSON-quoted when format=json is honoured
  let jwt = body;
  if (jwt.startsWith('{')) {
    const json = JSON.parse(jwt);
    throw new Error(`Special:OAuth/identify error: ${json.error || body.slice(0, 300)}`);
  }
  if (jwt.startsWith('"')) jwt = JSON.parse(jwt);

  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('identify: malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  if (header.alg !== 'HS256') throw new Error(`identify: unexpected JWT alg ${header.alg}`);

  const expected = crypto.createHmac('sha256', CONSUMER_SECRET).update(`${headerB64}.${payloadB64}`).digest();
  const actual = base64UrlDecode(sigB64);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('identify: JWT signature mismatch');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const issuer = IDENTIFY_ISSUER || new URL(INDEX_URL).origin;

  if (payload.iss !== issuer) throw new Error(`identify: unexpected issuer ${payload.iss}`);
  if (payload.aud !== CONSUMER_KEY) throw new Error('identify: audience mismatch');
  if (payload.nonce !== nonce) throw new Error('identify: nonce mismatch');
  if (typeof payload.exp === 'number' && payload.exp + JWT_CLOCK_SKEW_SEC < now) throw new Error('identify: JWT expired');
  if (typeof payload.iat === 'number' && payload.iat - JWT_CLOCK_SKEW_SEC > now) throw new Error('identify: JWT issued in the future');
  if (!payload.username || !payload.sub) throw new Error('identify: missing username/sub');

  return {
    username: String(payload.username),
    sub: String(payload.sub),
    blocked: Boolean(payload.blocked),
    groups: Array.isArray(payload.groups) ? payload.groups : []
  };
}

function isConfigured() {
  const { CONSUMER_KEY, CONSUMER_SECRET } = CONFIG.OAUTH;
  return Boolean(CONSUMER_KEY && CONSUMER_SECRET);
}

module.exports = {
  percentEncode,
  sign,
  initiate,
  getAuthorizeUrl,
  exchangeToken,
  identify,
  isConfigured
};
