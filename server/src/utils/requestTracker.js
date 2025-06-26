// --- Request Tracking (Simultaneous User Limitation) ---
// username → { startTime: number, endpoint: string }[]
const activeRequests = new Map();

// Maximum number of active requests per user
const MAX_ACTIVE_REQUESTS_PER_USER = 3; // Set as global variable

function hasActiveRequest(username) {
  return activeRequests.has(username) && activeRequests.get(username).length >= MAX_ACTIVE_REQUESTS_PER_USER;
}

function startRequest(username, endpoint) {
  if (!activeRequests.has(username)) {
    activeRequests.set(username, []);
  }
  activeRequests.get(username).push({
    startTime: Date.now(),
    endpoint
  });
}

function endRequest(username) {
  if (activeRequests.has(username)) {
    const requests = activeRequests.get(username);
    if (requests.length > 0) {
      requests.shift(); // Remove the oldest request
    }
    if (requests.length === 0) {
      activeRequests.delete(username);
    }
  }
}

function getActiveRequests() {
  const now = Date.now();
  return Array.from(activeRequests.entries()).flatMap(
    ([username, requests]) => requests.map(request => ({
      username,
      endpoint: request.endpoint,
      elapsedMs: now - request.startTime
    }))
  );
}

module.exports = {
  hasActiveRequest,
  startRequest,
  endRequest,
  getActiveRequests,
  MAX_ACTIVE_REQUESTS_PER_USER
}; 