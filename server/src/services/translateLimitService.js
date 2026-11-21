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
 * @returns {Promise<object>} Parsed config ({ settings: { tiers, default_max_calls_per_day }, blocklist })
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

/**
 * Normalize a max_calls_per_day value.
 * null / -1 => Infinity (unlimited). Non-negative number => floored integer.
 * Anything else (missing, invalid) => 0 (deny), logged as a warning.
 * @param {*} raw
 * @param {string} label - For logging
 * @returns {number}
 */
function normalizeLimit(raw, label) {
  if (raw === null || raw === -1 || raw === '-1') return Infinity;
  const n = Number(raw);
  if (raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0) {
    return Math.floor(n);
  }
  serverLogger.warn('CheckPageJSON invalid max_calls_per_day; treating as 0', { label, value: raw });
  return 0;
}

/**
 * Normalize CheckPageJSON settings.tiers into a predictable shape.
 * @param {object} settings
 * @returns {{ name: string, limit: number, groups: string[], users: string[] }[]}
 */
function normalizeTiers(settings) {
  const tiers = Array.isArray(settings.tiers) ? settings.tiers : [];
  return tiers
    .filter((t) => t && typeof t === 'object')
    .map((t, i) => {
      const name = t.name ? String(t.name) : `tier_${i}`;
      return {
        name,
        limit: normalizeLimit(t.max_calls_per_day, name),
        groups: Array.isArray(t.groups) ? t.groups.map((g) => String(g).trim().toLowerCase()) : [],
        users: Array.isArray(t.users) ? t.users.map((u) => String(u).trim()) : []
      };
    });
}

/**
 * Resolve the tier for a user.
 * 1) A tier that lists the user explicitly in `users` wins (first such tier in array order).
 * 2) Otherwise, the first tier (array order) whose `groups` intersect the user's groups/rights.
 * 3) Otherwise, settings.default_max_calls_per_day (missing => 0).
 * @param {object} settings
 * @param {string} username
 * @param {string[]} userRights - Lowercase groups/rights
 * @returns {{ name: string, limit: number }}
 */
function resolveTier(settings, username, userRights) {
  const tiers = normalizeTiers(settings);
  const name = username.trim();

  const byUser = tiers.find((t) => t.users.includes(name));
  if (byUser) return byUser;

  const byGroup = tiers.find((t) => t.groups.some((g) => userRights.includes(g)));
  if (byGroup) return byGroup;

  const hasDefault = Object.prototype.hasOwnProperty.call(settings, 'default_max_calls_per_day');
  return {
    name: 'default',
    limit: hasDefault ? normalizeLimit(settings.default_max_calls_per_day, 'default') : 0
  };
}

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

  const settings = config.settings && typeof config.settings === 'object' ? config.settings : {};
  const tier = resolveTier(settings, username, userRights);
  if (tier.limit === Infinity) {
    return { allowed: true };
  }
  const effectiveLimit = tier.limit;

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
