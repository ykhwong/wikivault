const express = require('express');
const axios = require('axios');
const { APIError } = require('../utils/errors');
const { getActiveRequests } = require('../utils/requestTracker');
const { getKeyQueues } = require('../utils/rateLimiter');
const { getCachedSuggestedPages } = require('../services/wikiService');
const { getFileData } = require('../services/fileService');
const { serverLogger } = require('../config/logger');

const router = express.Router();

// Recommended pages
router.get("/get-suggested-pages", (req, res) => {
  const cachedSuggestedPages = getCachedSuggestedPages();
  if (!cachedSuggestedPages) {
    return res.status(503).json({ error: "Data not ready yet. Please try again later." });
  }
  res.json(cachedSuggestedPages);
});

// JS deployment file content
router.get("/get-js-content", async (req, res) => {
  try {
    const { cachedData } = await getFileData();
    if (!cachedData) throw new Error("File content not loaded");
    res.send(cachedData);
  } catch (e) {
    res.status(500).json({ error: "Error reading file content" });
  }
});

// External URL info
router.post('/get-source-info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) throw new APIError("Missing URL in request", 400);

    // URL validation
    try {
      new URL(url);
    } catch (e) {
      throw new APIError("Invalid URL format", 400);
    }

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(url, {
          maxRedirects: 5,
          validateStatus: status => status >= 200 && status < 400,
          timeout: 10000, // 10 seconds timeout
          httpsAgent: new (require('https').Agent)({
            rejectUnauthorized: false // SSL certificate verification disabled
          }),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        const actualUri = response.request.res.responseUrl || url;
        const pageTitle = (response.data.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '-';
        return res.json({ pageTitle, actualUri });
      } catch (e) {
        lastError = e;
        
        // Handle specific errors
        if (e.code === 'EAI_AGAIN') {
          // DNS lookup failed - wait a bit and retry
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        
        if (e.response?.status === 403) {
          // 403 error is likely to persist, so return error immediately
          throw new APIError("Access denied by the target website", 403);
        }

        if (attempt === maxRetries) {
          // If it still fails on the last attempt
          if (e.code === 'ECONNABORTED') {
            throw new APIError("Request timed out", 504);
          }
          if (e.code === 'EAI_AGAIN') {
            throw new APIError("DNS lookup failed", 502);
          }
          throw new APIError(e.message || "Failed to fetch URL", e.response?.status || 500);
        }

        // For other errors, wait a bit and retry
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  } catch (e) {
    serverLogger.error('Source info API error:', e);
    res.status(e.statusCode || 500).json({ 
      error: e.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? e.stack : undefined
    });
  }
});

// --- Status check endpoint: active requests + Bottleneck queue size per key ---
router.get('/status', (req, res) => {
  const active = getActiveRequests();
  const keyQueues = getKeyQueues();

  res.json({
    activeCount: active.length,
    maxActiveRequestsPerUser: 3,
    active,
    keyQueues
  });
});

module.exports = router; 
