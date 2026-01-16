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
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let logMessage = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    // If there are additional metadata, stringify them
    const metaKeys = Object.keys(meta).filter(key => key !== 'timestamp' && key !== 'level' && key !== 'message' && key !== 'splat');
    if (metaKeys.length > 0) {
      const metaObj = {};
      metaKeys.forEach(key => {
        metaObj[key] = meta[key];
      });
      logMessage += ' ' + JSON.stringify(metaObj);
    }
    return logMessage;
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