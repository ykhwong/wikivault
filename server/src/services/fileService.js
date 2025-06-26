const fs = require('fs');
const path = require('path');
const { serverLogger } = require('../config/logger');

// --- deploy.dat file caching ---
const filePath = path.join(__dirname, "../../../deploy/deploy.dat");
let cachedData = null, lastModified = null;

async function loadFile() {
  try {
    const stats = await fs.promises.stat(filePath);
    lastModified = Math.floor(stats.mtimeMs);
    cachedData = await fs.promises.readFile(filePath, "utf8");
  } catch (e) {
    serverLogger.error(`File load error: ${e.message}`);
  }
}

async function getFileData() {
  try {
    const stats = await fs.promises.stat(filePath);
    const mod = Math.floor(stats.mtimeMs);
    if (!cachedData || mod !== lastModified) {
      await loadFile();
    }
    return { cachedData, lastModified };
  } catch (e) {
    throw new Error("File not found or inaccessible");
  }
}

// initial load
loadFile().then(() =>
  serverLogger.info('Initial file load completed')
).catch(e =>
  serverLogger.error('Initial file load failed:', e)
);

module.exports = {
  getFileData,
  cachedData,
  lastModified
}; 