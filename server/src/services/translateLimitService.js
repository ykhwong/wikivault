const axios = require('axios');
const fs = require('fs').promises;
const CONFIG = require('../config');
const { serverLogger } = require('../config/logger');

const CHECKPAGE_TIMEOUT_MS = 10000;
const USER_API_TIMEOUT_MS = 10000;

/** @type {Promise<void> | null} - mutex for serialize file writes */
let usageFileLock = Promise.resolve();

/**
 * Fetch and parse CheckPageJSON from Korean Wikipedia.
 * @returns {Promise<object>} Parsed config (settings, max_calls_per_day, blocklist)
 * @throws {Error} On network or parse failure
 */
async function fetchCheckPageJSON() {
  const url = CONFIG.API.CHECKPAGE_JSON_URL;
  const res = await axios.get(url, {
    timeout: CHECKPAGE_TIMEOUT_MS,
    responseType: 'text',
    headers: { 'User-Agent': 'WikiVault/1.0 (Translate limit check)' }
  });
  const raw = res.data;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('CheckPageJSON empty response');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`CheckPageJSON parse error: ${e.message}`);
  }
}

/**
 * Fetch user groups and rights from Korean Wikipedia API.
 * @param {string} username - MediaWiki username
 * @returns {Promise<string[]>} Combined list of group and right names (lowercase)
 * @throws {Error} On network failure or user not found
 */
async function fetchUserRights(username) {
  const apiUrl = CONFIG.API.KO_WIKI_URL;
  const params = {
    action: 'query',
    list: 'users',
    ususers: username,
    usprop: 'groups|rights',
    format: 'json',
    origin: '*'
  };
  const res = await axios.get(apiUrl, {
    params,
    timeout: USER_API_TIMEOUT_MS,
    headers: { 'User-Agent': 'WikiVault/1.0 (Translate limit check)' }
  });
  const data = res.data;
  const users = data?.query?.users;
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('User not found or API returned no users');
  }
  const u = users[0];
  if (u.userid === undefined || u.userid === null) {
    throw new Error('User does not exist');
  }
  const groups = Array.isArray(u.groups) ? u.groups : [];
  const rights = Array.isArray(u.rights) ? u.rights : [];
  return [...groups, ...rights].map((s) => String(s).toLowerCase());
}

/**
 * Get today's date in KST as YYYY-MM-DD.
 * @returns {string}
 */
function getTodayKSTDate() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}

/**
 * Read usage file. Returns empty structure if file missing or invalid.
 * @returns {Promise<Record<string, Record<string, number>>>}
 */
async function readUsageFile() {
  const filePath = CONFIG.API.TRANSLATE_USAGE_FILE;
  try {
    const data = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      serverLogger.warn('Translate usage file read error:', { path: filePath, message: e.message });
    }
  }
  return {};
}

/**
 * Increment usage for date/username and save. Serialized with a simple lock.
 * @param {string} date - YYYY-MM-DD (KST)
 * @param {string} username
 * @returns {Promise<void>}
 */
async function incrementAndSaveUsage(date, username) {
  const filePath = CONFIG.API.TRANSLATE_USAGE_FILE;
  usageFileLock = usageFileLock.then(async () => {
    const usage = await readUsageFile();
    if (!usage[date]) usage[date] = {};
    usage[date][username] = (usage[date][username] || 0) + 1;
    await fs.writeFile(filePath, JSON.stringify(usage, null, 2), 'utf8');
  });
  await usageFileLock;
}

/** Tier keys in priority order for max_calls_per_day */
const LIMIT_TIERS = ['extendedconfirmed', 'confirmed', 'autoconfirmed'];

/**
 * Determine if user is allowed and why not if blocked.
 * @param {object} config - Parsed CheckPageJSON
 * @param {string} username
 * @param {string[]} userRights - Lowercase groups/rights
 * @returns {Promise<{ allowed: boolean, statusCode?: number, message?: string, limit?: number, current?: number }>}
 */
async function checkLimit(config, username, userRights) {
  const blocklist = config.blocklist || {};
  const blockUsers = Array.isArray(blocklist.users) ? blocklist.users : [];
  const normalizedBlock = blockUsers.map((u) => String(u).trim());
  if (normalizedBlock.includes(username.trim())) {
    return { allowed: false, statusCode: 403, message: 'Access denied (blocklist).' };
  }

  const settings = config.settings || {};
  const unlimitedGroups = Array.isArray(settings.unlimited_groups) ? settings.unlimited_groups.map((g) => String(g).toLowerCase()) : [];
  const unlimitedUsers = Array.isArray(settings.unlimited_users) ? settings.unlimited_users.map((u) => String(u).trim()) : [];
  if (unlimitedGroups.some((g) => userRights.includes(g))) {
    return { allowed: true };
  }
  if (unlimitedUsers.includes(username.trim())) {
    return { allowed: true };
  }

  const maxCalls = config.max_calls_per_day || {};
  let tier = 'others';
  for (const t of LIMIT_TIERS) {
    if (userRights.includes(t.toLowerCase())) {
      tier = t;
      break;
    }
  }
  const limitRaw = maxCalls[tier];
  const limit = limitRaw === -1 || limitRaw === '-1' ? -1 : parseInt(Number(limitRaw), 10);
  if (limit === -1 || (Number.isNaN(limit) && limitRaw !== 0)) {
    return { allowed: true };
  }
  const effectiveLimit = Number.isNaN(limit) ? 0 : Math.max(0, limit);

  const today = getTodayKSTDate();
  const usage = await readUsageFile();
  const dayUsage = usage[today] || {};
  const current = dayUsage[username] || 0;
  if (current >= effectiveLimit) {
    return {
      allowed: false,
      statusCode: 429,
      message: `Daily limit reached (${effectiveLimit} calls per day in KST).`,
      limit: effectiveLimit,
      current
    };
  }
  return { allowed: true };
}

module.exports = {
  fetchCheckPageJSON,
  fetchUserRights,
  getTodayKSTDate,
  readUsageFile,
  incrementAndSaveUsage,
  checkLimit
};
