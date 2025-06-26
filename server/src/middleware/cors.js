const cors = require("cors");
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, false);
    if (CONFIG.CORS.ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    if (!origin.endsWith('.wikipedia.org')) {
      serverLogger.warn(`Blocked CORS origin: ${origin}`);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
};

const corsMiddleware = cors(corsOptions);

const originCheckMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !CONFIG.CORS.ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).send('Forbidden');
  }
  next();
};

const securityHeadersMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  const secFetchMode = req.headers['sec-fetch-mode'];
  const secFetchDest = req.headers['sec-fetch-dest'];
  const secFetchSite = req.headers['sec-fetch-site'];
  const userAgent = req.headers['user-agent'] || 'unknown user-agent';
  const reqOriginalUrl = req.originalUrl;
  const reqMethod = req.method;

  // Check if Origin header exists and is allowed
  if (!origin || !CONFIG.CORS.ALLOWED_ORIGINS.includes(origin)) {
    serverLogger.warn(`Blocked request: Invalid origin header from ${origin || 'unknown origin'} - UA: ${userAgent} - Url: ${reqOriginalUrl} - Method: ${reqMethod}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Check Sec-Fetch-* headers
  const hasValidSecFetch = secFetchMode === 'cors' && 
                          secFetchDest === 'empty' && 
                          secFetchSite !== undefined;

  if (!hasValidSecFetch) {
    serverLogger.warn(`Blocked request: Invalid security headers from ${origin}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};

module.exports = {
  corsMiddleware,
  originCheckMiddleware,
  securityHeadersMiddleware
}; 