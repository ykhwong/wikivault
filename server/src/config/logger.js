const fs = require('fs');
const path = require('path');
const winston = require('winston');
const CONFIG = require('./index');

// Create log directory
if (!fs.existsSync(CONFIG.LOGS.DIR)) {
  fs.mkdirSync(CONFIG.LOGS.DIR);
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

const serverLogger = winston.createLogger({ 
  format: logFormat, 
  transports: [
    new winston.transports.File({ filename: path.join(CONFIG.LOGS.DIR, CONFIG.LOGS.SERVER), level: 'info' })
  ]
});

const apiTranslateLogger = winston.createLogger({ 
  format: logFormat, 
  transports: [
    new winston.transports.File({ filename: path.join(CONFIG.LOGS.DIR, CONFIG.LOGS.API_TRANSLATE), level: 'info' })
  ]
});

const apiCreateLogger = winston.createLogger({ 
  format: logFormat, 
  transports: [
    new winston.transports.File({ filename: path.join(CONFIG.LOGS.DIR, CONFIG.LOGS.API_CREATE), level: 'info' })
  ]
});

// In development environment, also output to console
if (process.env.NODE_ENV !== 'production') {
  serverLogger.add(new winston.transports.Console());
  apiTranslateLogger.add(new winston.transports.Console());
  apiCreateLogger.add(new winston.transports.Console());
}

module.exports = {
  serverLogger,
  apiTranslateLogger,
  apiCreateLogger
}; 