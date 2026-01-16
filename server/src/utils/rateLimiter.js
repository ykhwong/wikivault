const Bottleneck = require("bottleneck");
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');
const { sanitizeResponseData } = require('./errors');

// --- Bottleneck for key-specific rate-limiting (v2.19.5) ---
const keyLimiters = CONFIG.API.KEYS.map(key => ({
  key,
  limiter: new Bottleneck({
    minTime: CONFIG.REQUEST.MIN_INTERVAL,
    maxConcurrent: 1
  })
}));
let currentKeyIndex = 0;

/**
 * requestFn: (apiKey: string) => Promise<AxiosResponse>
 */
async function requestWithRateLimiting(requestFn) {
  const slot = keyLimiters[currentKeyIndex];
  const usedKeyIndex = currentKeyIndex;
  currentKeyIndex = (currentKeyIndex + 1) % keyLimiters.length;
  try {
    return await slot.limiter.schedule(() => requestFn(slot.key));
  } catch (err) {
    serverLogger.error('Error in requestWithRateLimiting:', {
      keyIndex: usedKeyIndex,
      message: err.message,
      code: err.code,
      responseStatus: err.response?.status,
      responseData: sanitizeResponseData(err.response?.data),
      stack: err.stack
    });
    throw err;
  }
}

function getKeyQueues() {
  return keyLimiters.map(({ key, limiter }, index) => ({
    keyIndex: index,
    queuedCount: limiter.jobs().length
  }));
}

module.exports = {
  requestWithRateLimiting,
  getKeyQueues
}; 