const express = require('express');
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');
const oauth = require('../services/oauthService');
const { issueSessionToken } = require('../services/sessionService');

const router = express.Router();

const MESSAGE_TYPE = 'wikivault-oauth';
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Logins in progress, keyed by request token.
 * @type {Map<string, { secret: string, origin: string, state: string, createdAt: number }>}
 */
const pendingLogins = new Map();

function prunePending() {
  const cutoff = Date.now() - CONFIG.OAUTH.PENDING_TTL_MS;
  for (const [key, entry] of pendingLogins) {
    if (entry.createdAt < cutoff) pendingLogins.delete(key);
  }
}

/** Serialize data so it can be embedded safely inside a <script> block. */
function toScriptJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Render the page shown in the login popup. It hands the result to the gadget
 * (window.opener on ko.wikipedia.org) via postMessage and closes itself.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {{ origin?: string, message: object, text: string }} opts
 */
function renderResult(res, status, { origin, message, text }) {
  const script = origin
    ? `<script>
(function () {
  var data = ${toScriptJson(message)};
  var origin = ${toScriptJson(origin)};
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(data, origin);
    setTimeout(function () { window.close(); }, data.error ? 4000 : 300);
  } else {
    document.getElementById('hint').textContent =
      '원래 창과 연결이 끊어졌습니다. 이 창을 닫고 위키백과에서 다시 시도해 주세요.';
  }
})();
</script>`
    : '';

  res.status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    })
    .send(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WikiVault 로그인</title>
<style>body{font-family:sans-serif;max-width:32em;margin:3em auto;padding:0 16px;line-height:1.6;color:#202122}</style>
</head><body>
<h1 style="font-size:1.3em">WikiVault</h1>
<p>${escapeHtml(text)}</p>
<p id="hint" style="color:#72777d"></p>
${script}
</body></html>`);
}

// Step 1+2: get a request token and send the user to Special:OAuth/authorize
router.get('/login', async (req, res) => {
  const origin = String(req.query.origin || '');
  const state = String(req.query.state || '');

  if (!CONFIG.CORS.ALLOWED_ORIGINS.includes(origin) || !STATE_PATTERN.test(state)) {
    return renderResult(res, 400, { message: {}, text: '잘못된 로그인 요청입니다.' });
  }
  if (!oauth.isConfigured()) {
    serverLogger.error('OAuth login requested but OAUTH_CONSUMER_KEY/SECRET are not set');
    return renderResult(res, 503, {
      origin,
      message: { type: MESSAGE_TYPE, state, error: '서버에 OAuth가 설정되어 있지 않습니다.' },
      text: '서버에 OAuth가 설정되어 있지 않습니다.'
    });
  }

  prunePending();
  if (pendingLogins.size >= CONFIG.OAUTH.MAX_PENDING) {
    return renderResult(res, 503, {
      origin,
      message: { type: MESSAGE_TYPE, state, error: '로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
      text: '로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
    });
  }

  try {
    const requestToken = await oauth.initiate();
    pendingLogins.set(requestToken.key, {
      secret: requestToken.secret,
      origin,
      state,
      createdAt: Date.now()
    });
    res.set('Cache-Control', 'no-store');
    return res.redirect(oauth.getAuthorizeUrl(requestToken.key));
  } catch (e) {
    serverLogger.error(`OAuth initiate failed: ${e.message}`);
    return renderResult(res, 502, {
      origin,
      message: { type: MESSAGE_TYPE, state, error: '위키백과 로그인 시작에 실패했습니다.' },
      text: '위키백과 로그인 시작에 실패했습니다. 잠시 후 다시 시도해 주세요.'
    });
  }
});

// Step 3+4: exchange the verifier, identify the user, hand a session token to the gadget
router.get('/callback', async (req, res) => {
  const requestKey = String(req.query.oauth_token || '');
  const verifier = String(req.query.oauth_verifier || '');

  prunePending();
  const pending = pendingLogins.get(requestKey);
  if (!pending) {
    return renderResult(res, 400, {
      message: {},
      text: '로그인 요청이 만료되었거나 올바르지 않습니다. 위키백과에서 다시 시도해 주세요.'
    });
  }
  pendingLogins.delete(requestKey); // single use

  const { origin, state } = pending;
  if (!verifier) {
    return renderResult(res, 400, {
      origin,
      message: { type: MESSAGE_TYPE, state, error: '로그인이 취소되었습니다.' },
      text: '로그인이 취소되었습니다.'
    });
  }

  try {
    const accessToken = await oauth.exchangeToken(requestKey, pending.secret, verifier);
    const user = await oauth.identify(accessToken.key, accessToken.secret);
    // The access token is not stored: WikiVault only needs to know who the user is.
    const session = issueSessionToken(user);
    serverLogger.info(`OAuth login succeeded - User: ${user.username}`);

    return renderResult(res, 200, {
      origin,
      message: { type: MESSAGE_TYPE, state, token: session.token, exp: session.exp, username: user.username },
      text: `${user.username} 님으로 로그인했습니다. 이 창은 곧 닫힙니다.`
    });
  } catch (e) {
    serverLogger.error(`OAuth callback failed: ${e.message}`);
    return renderResult(res, 502, {
      origin,
      message: { type: MESSAGE_TYPE, state, error: '로그인 확인에 실패했습니다.' },
      text: '로그인 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.'
    });
  }
});

module.exports = router;
