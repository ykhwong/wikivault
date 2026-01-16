const Bottleneck = require("bottleneck");
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');
const { sanitizeResponseData, readErrorResponseData } = require('./errors');

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
    const is429Error = err.response?.status === 429;
    const logData = {
      keyIndex: usedKeyIndex,
      message: err.message,
      code: err.code,
      responseStatus: err.response?.status,
      responseData: sanitizeResponseData(err.response?.data),
      stack: err.stack
    };
    
    // 429 오류인 경우 상세 정보를 추가로 로그에 남김
    if (is429Error) {
      // 응답 데이터에서 실제 오류 메시지 읽기
      const errorResponseData = await readErrorResponseData(err.response?.data);
      logData.gemini429Error = {
        status: err.response?.status,
        statusText: err.response?.statusText,
        headers: err.response?.headers,
        errorMessage: errorResponseData,
        errorDetails: typeof errorResponseData === 'object' ? errorResponseData : { rawMessage: errorResponseData },
        requestUrl: err.config?.url,
        requestMethod: err.config?.method
      };
      serverLogger.error('Gemini API 429 Rate Limit Error in requestWithRateLimiting:', logData);
    } else {
      serverLogger.error('Error in requestWithRateLimiting:', logData);
    }
    
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