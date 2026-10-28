const fs = require("fs");
const path = require("path");

function intFromEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${key} must be a number, got "${raw}"`);
  return value;
}

function requiredFromEnv(missing) {
  const raw = (key) => {
    const value = process.env[key];
    if (value === undefined || value.trim() === "") {
      missing.push(key);
      return null;
    }
    return value.trim();
  };
  return {
    string: (key) => raw(key),
    int: (key) => {
      const value = raw(key);
      if (value === null) return null;
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        throw new Error(`${key} must be a non-negative number, got "${value}"`);
      }
      return parsed;
    },
    list: (key) => {
      const value = raw(key);
      if (value === null) return null;
      const items = value.split(",").map((item) => item.trim()).filter(Boolean);
      if (items.length === 0) missing.push(key);
      return items;
    },
  };
}

function loadConfig() {
  const missing = [];
  const env = requiredFromEnv(missing);
  const requirements = {
    requiredFaction: env.string("REQUIRED_FACTION"),
    requiredServer: env.string("REQUIRED_SERVER"),
    minLevel: env.int("MIN_LEVEL"),
    minGearScore: env.int("MIN_GS"),
    minAccountAgeDays: env.int("MIN_ACCOUNT_AGE_DAYS"),
    ticketGearSlots: env.list("TICKET_GEAR_SLOTS"),
    maxNameLength: env.int("MAX_CHARACTER_NAME_LENGTH"),
    archivedTicketRetentionDays: env.int("ARCHIVED_TICKET_RETENTION_DAYS"),
  };
  const shugo = {
    baseUrl: env.string("SHUGO_BASE_URL")?.replace(/\/+$/, ""),
    regionPath: env.string("SHUGO_REGION_PATH")?.replace(/^\/+|\/+$/g, ""),
    userAgent: env.string("SHUGO_USER_AGENT"),
    requestTimeoutMs: env.int("SHUGO_REQUEST_TIMEOUT_MS"),
    minRequestGapMs: env.int("SHUGO_MIN_REQUEST_GAP_MS"),
    cacheTtlMs: env.int("SHUGO_CACHE_TTL_MS"),
  };
  if (missing.length > 0) {
    throw new Error(`Missing verification settings in .env: ${missing.join(", ")}`);
  }

  const mode = (process.env.VERIFY_MODE || "shadow").trim();
  if (!["shadow", "live"].includes(mode)) {
    throw new Error(`VERIFY_MODE must be "shadow" or "live", got "${mode}"`);
  }

  const grantDelayMinSeconds = intFromEnv("VERIFY_GRANT_DELAY_MIN_SECONDS", 60);
  const grantDelayMaxSeconds = intFromEnv("VERIFY_GRANT_DELAY_MAX_SECONDS", 300);
  if (grantDelayMinSeconds < 0 || grantDelayMaxSeconds < grantDelayMinSeconds) {
    throw new Error(
      "VERIFY_GRANT_DELAY_MIN_SECONDS must be >= 0 and <= VERIFY_GRANT_DELAY_MAX_SECONDS"
    );
  }

  return {
    mode,
    grantDelayMinSeconds,
    grantDelayMaxSeconds,
    verifiedRoleId: process.env.VERIFIED_ROLE_ID,
    verifyChannelId: process.env.VERIFY_CHANNEL_ID,
    logChannelId: process.env.VERIFY_LOG_CHANNEL_ID,
    reviewChannelId: process.env.VERIFY_REVIEW_CHANNEL_ID,
    officersRoleId: process.env.OFFICERS_ROLE_ID,
    ticketsCategoryId: process.env.REVIEW_TICKETS_CATEGORY_ID,
    archivedTicketsCategoryId: process.env.ARCHIVED_REVIEW_TICKETS_CATEGORY_ID,
    ...requirements,
    shugo,
    submitCooldownSeconds: intFromEnv("VERIFY_COOLDOWN_SECONDS", 60),
  };
}

function missingKeys(config) {
  const required = {
    VERIFIED_ROLE_ID: config.verifiedRoleId,
    VERIFY_CHANNEL_ID: config.verifyChannelId,
    VERIFY_LOG_CHANNEL_ID: config.logChannelId,
    VERIFY_REVIEW_CHANNEL_ID: config.reviewChannelId,
    OFFICERS_ROLE_ID: config.officersRoleId,
    REVIEW_TICKETS_CATEGORY_ID: config.ticketsCategoryId,
    ARCHIVED_REVIEW_TICKETS_CATEGORY_ID: config.archivedTicketsCategoryId,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

let cachedConfig = null;

function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

const ENV_PATH = path.join(__dirname, "..", "..", ".env");

const EDITABLE_SETTINGS = {
  MIN_LEVEL: { label: "Min level", min: 1, max: 100, unit: "" },
  MIN_GS: { label: "Min gear score", min: 0, max: 100000, unit: "" },
  MIN_ACCOUNT_AGE_DAYS: { label: "Min account age", min: 0, max: 3650, unit: " days" },
  ARCHIVED_TICKET_RETENTION_DAYS: { label: "Archived tickets kept", min: 1, max: 365, unit: " days" },
};

function updateSetting(key, value) {
  const setting = EDITABLE_SETTINGS[key];
  if (!setting) throw new Error(`${key} can't be changed from Discord`);
  if (!Number.isInteger(value) || value < setting.min || value > setting.max) {
    throw new Error(`${setting.label} must be a whole number from ${setting.min} to ${setting.max}`);
  }

  const previous = process.env[key];
  const text = fs.readFileSync(ENV_PATH, "utf8");
  const line = new RegExp(`^${key}=.*$`, "m");
  const updated = line.test(text)
    ? text.replace(line, `${key}=${value}`)
    : `${text.replace(/\s*$/, "")}\n${key}=${value}\n`;
  fs.writeFileSync(ENV_PATH, updated);

  process.env[key] = String(value);
  cachedConfig = null;
  return { previous, current: String(value) };
}

module.exports = { loadConfig, getConfig, missingKeys, EDITABLE_SETTINGS, updateSetting };
