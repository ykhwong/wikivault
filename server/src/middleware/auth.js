const CONFIG = require('../config');
const { verifySessionToken } = require('../services/sessionService');

/**
 * Reads "Authorization: Bearer <token>" and, if valid, sets req.wikiUser.
 * Requests with an invalid/expired token are rejected with 401 so the gadget can log in again.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return next();

  const user = verifySessionToken(match[1]);
  if (!user) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'invalid_token' });
  }
  req.wikiUser = user;
  next();
}

/**
 * Requires a verified user. The verified username replaces whatever the client sent
 * in the body, so routes can keep reading req.body.username.
 * With OAUTH_ENFORCE=false, unauthenticated requests fall back to the body username (legacy).
 */
function requireUser(req, res, next) {
  if (req.wikiUser) {
    if (req.body && typeof req.body === 'object') {
      req.body.username = req.wikiUser.username;
    }
    return next();
  }
  if (!CONFIG.OAUTH.ENFORCE) return next();
  return res.status(401).json({ error: 'Login required.', code: 'auth_required' });
}

module.exports = {
  authenticate,
  requireUser
};
