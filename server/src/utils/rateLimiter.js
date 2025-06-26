const Bottleneck = require("bottleneck");
const CONFIG = require('../config');

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
  currentKeyIndex = (currentKeyIndex + 1) % keyLimiters.length;
  return slot.limiter.schedule(() => requestFn(slot.key));
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