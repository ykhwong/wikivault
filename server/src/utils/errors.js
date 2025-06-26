const { serverLogger } = require('../config/logger');

class APIError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    serverLogger.error(`${this.name}: ${message} (Status: ${statusCode})`);
  }
}

module.exports = {
  APIError
}; 