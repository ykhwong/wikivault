const express = require("express");
const CONFIG = require('./config');
const { serverLogger } = require('./config/logger');
const { corsMiddleware, originCheckMiddleware, securityHeadersMiddleware } = require('./middleware/cors');
const { authenticate, requireUser } = require('./middleware/auth');
const { fetchSuggestedPages } = require('./services/wikiService');

// Routes
const initRoutes = require('./routes/init');
const createRoutes = require('./routes/create');
const translateRoutes = require('./routes/translate');
const otherRoutes = require('./routes/other');
const oauthRoutes = require('./routes/oauth');

const app = express();

// OAuth login pages are opened as top-level navigations in a popup (no CORS Origin,
// Sec-Fetch-Mode: navigate), so they are mounted before the API security middleware.
app.use('/oauth', oauthRoutes);

// Middleware setup
app.use(corsMiddleware);
app.use(originCheckMiddleware);
app.use(securityHeadersMiddleware);
app.use(express.json({ limit: CONFIG.REQUEST.FILE_SIZE_LIMIT }));
app.use('/api', authenticate);
app.use(['/api/translate', '/api/fast-translate', '/api/create', '/api/get-source-info'], requireUser);

// Route setup
app.use('/api', initRoutes);
app.use('/api', createRoutes);
app.use('/api', translateRoutes);
app.use('/api', otherRoutes);

// Global error handler
app.use((err, req, res, next) => {
  const status = err.statusCode || 500;
  const message = status === 403 ? 'Forbidden' : err.message || 'Internal server error';
  serverLogger.error(`Error ${status}: ${err.message}`);
  res.status(status).json({ error: message });
});

// Initial data load
fetchSuggestedPages().then(() =>
  serverLogger.info('Initial suggested pages fetch completed')
).catch(e =>
  serverLogger.error('Initial suggested pages fetch failed:', e)
);

// Periodic update
setInterval(fetchSuggestedPages, CONFIG.UPDATE_INTERVAL);

module.exports = app; 