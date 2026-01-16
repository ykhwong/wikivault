const { serverLogger } = require('../config/logger');

class APIError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    serverLogger.error(`${this.name}: ${message} (Status: ${statusCode})`);
  }
}

/**
 * Cleans response data for logging by removing stream objects and large buffers
 */
function sanitizeResponseData(data) {
  if (!data) return null;
  
  // If it's a stream object or has stream-like properties, return a simple indicator
  if (typeof data === 'object' && (
    data._readableState || 
    data._writableState || 
    data._events ||
    data.readable ||
    data.writable
  )) {
    return '[Stream object]';
  }
  
  // If it's a Buffer, return its length
  if (Buffer.isBuffer(data)) {
    return `[Buffer: ${data.length} bytes]`;
  }
  
  // If it's an array with Buffer elements, summarize
  if (Array.isArray(data)) {
    return data.map(item => {
      if (Buffer.isBuffer(item)) {
        return `[Buffer: ${item.length} bytes]`;
      }
      if (typeof item === 'object' && item.chunk && Buffer.isBuffer(item.chunk)) {
        return `[Buffer chunk: ${item.chunk.length} bytes]`;
      }
      return sanitizeResponseData(item);
    });
  }
  
  // If it's a plain object, recursively sanitize
  if (typeof data === 'object' && data.constructor === Object) {
    const sanitized = {};
    for (const key in data) {
      // Skip internal stream properties
      if (key.startsWith('_') || 
          key === 'readableState' || 
          key === 'writableState' || 
          key === 'events' ||
          key === '_events' ||
          key === '_eventsCount') {
        continue;
      }
      sanitized[key] = sanitizeResponseData(data[key]);
    }
    return sanitized;
  }
  
  // For primitive types or other objects, return as-is (but limit string length)
  if (typeof data === 'string' && data.length > 500) {
    return data.substring(0, 500) + '...[truncated]';
  }
  
  return data;
}

module.exports = {
  APIError,
  sanitizeResponseData
}; 