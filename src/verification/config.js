const fs = require("fs");
const path = require("path");
const { isValidTimeZone } = require("../time");
const { parseRoleMap, importsFromEnv, missingRequired, toConfigFields } = require("../settings/ids");
const { getStore } = require("./store");

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
    bool: (key) => {
      const value = raw(key);
      if (value === null) return null;
      const lower = value.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        throw new Error(`${key} must be true or false, got "${value}"`);
      }
      return lower === "true";
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

function parseLegionRoles(raw) {
  return parseRoleMap(raw, "LEGION_ROLES");
}

function parseClassRoles(raw) {
  return parseRoleMap(raw, "CLASS_ROLES");
}

function parseTicketRenames(raw) {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      const phrase = entry.slice(0, separator).trim();
      const prefix = entry.slice(separator + 1).trim().toLowerCase();
      if (separator < 1 || !phrase || !/^[a-z0-9_]+$/.test(prefix)) {
        throw new Error(`MEE6_TICKET_RENAMES entry "${entry}" must look like Phrase:prefix`);
      }
      return { phrase, prefix };
    });
}

function parseTime(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

const LOOKUP_SOURCE_NAMES = ["aion2index", "shugo"];

function parseLookupSources(raw) {
  const sources = (raw ?? "shugo")
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);
  if (sources.length === 0) throw new Error("LOOKUP_SOURCES must name at least one site");
  for (const source of sources) {
    if (!LOOKUP_SOURCE_NAMES.includes(source)) {
      throw new Error(`LOOKUP_SOURCES: unknown site "${source}" (use ${LOOKUP_SOURCE_NAMES.join(", ")})`);
    }
  }
  if (new Set(sources).size !== sources.length) throw new Error("LOOKUP_SOURCES lists a site twice");
  return sources;
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
    strictVerification: env.bool("STRICT_VERIFICATION"),
  };
  const lookup = {
    sources: parseLookupSources(process.env.LOOKUP_SOURCES),
    failoverMinutes: intFromEnv("LOOKUP_FAILOVER_MINUTES", 5),
    userAgent: env.string("SHUGO_USER_AGENT"),
    requestTimeoutMs: env.int("SHUGO_REQUEST_TIMEOUT_MS"),
    cacheTtlMs: env.int("SHUGO_CACHE_TTL_MS"),
    healthcheckCharacter: process.env.SHUGO_HEALTHCHECK_CHARACTER?.trim() || null,
  };
  const shugo = {
    baseUrl: env.string("SHUGO_BASE_URL")?.replace(/\/+$/, ""),
    regionPath: env.string("SHUGO_REGION_PATH")?.replace(/^\/+|\/+$/g, ""),
    minRequestGapMs: env.int("SHUGO_MIN_REQUEST_GAP_MS"),
  };
  const aion2index = {
    apiKey: process.env.AION2INDEX_API_KEY?.trim() || null,
    baseUrl: (process.env.AION2INDEX_BASE_URL?.trim() || "https://aion2index.com/api/v1/characters").replace(
      /\/+$/,
      ""
    ),
    regionPath: (process.env.AION2INDEX_REGION_PATH?.trim() || "eu/israphel").replace(/^\/+|\/+$/g, ""),
    minRequestGapMs: intFromEnv("AION2INDEX_MIN_REQUEST_GAP_MS", 1500),
  };
  if (missing.length > 0) {
    throw new Error(`Missing verification settings in .env: ${missing.join(", ")}`);
  }
  if (lookup.sources.includes("aion2index") && !aion2index.apiKey) {
    throw new Error("LOOKUP_SOURCES includes aion2index, but AION2INDEX_API_KEY is empty");
  }
  if (lookup.failoverMinutes < 0) throw new Error("LOOKUP_FAILOVER_MINUTES must be >= 0");

  const rawRecheckTime = process.env.DAILY_RECHECK_TIME?.trim() || null;
  const dailyRecheckTime = rawRecheckTime && parseTime(rawRecheckTime);
  if (rawRecheckTime && !dailyRecheckTime) {
    throw new Error(`DAILY_RECHECK_TIME must look like HH:MM (24-hour), got "${rawRecheckTime}"`);
  }

  const timeZone = process.env.TIMEZONE?.trim() || "Europe/Helsinki";
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`TIMEZONE must be a time zone name like Europe/Berlin, got "${timeZone}"`);
  }
  const timeslots = {
    durationMinutes: intFromEnv("TIMESLOT_DURATION", 30),
    minHoursBeforeEvent: intFromEnv("TIMESLOT_MIN_HOURS_BEFORE_EVENT", 3),
  };
  if (timeslots.durationMinutes < 1) throw new Error("TIMESLOT_DURATION must be at least 1");
  if (timeslots.minHoursBeforeEvent < 0) throw new Error("TIMESLOT_MIN_HOURS_BEFORE_EVENT must be >= 0");

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

  for (const key of ["RAID_SUBMISSIONS_THRESHOLD", "RAID_WINDOW_SECONDS", "RAID_PAUSE_MINUTES"]) {
    if (intFromEnv(key, 1) < 1) throw new Error(`${key} must be at least 1`);
  }

  const ids = toConfigFields(getStore().getServerSettings());

  return {
    mode,
    grantDelayMinSeconds,
    grantDelayMaxSeconds,
    ...ids,
    mee6TicketRenames: parseTicketRenames(process.env.MEE6_TICKET_RENAMES),
    roster: {
      ...ids.roster,
      raidHelperApiKey: process.env.RAID_HELPER_API_KEY?.trim() || null,
    },
    ...requirements,
    lookup,
    shugo,
    aion2index,
    dailyRecheckTime,
    timeZone,
    timeslots,
    submitCooldownSeconds: intFromEnv("VERIFY_COOLDOWN_SECONDS", 60),
    raid: {
      submissionsThreshold: intFromEnv("RAID_SUBMISSIONS_THRESHOLD", 20),
      windowSeconds: intFromEnv("RAID_WINDOW_SECONDS", 60),
      pauseMinutes: intFromEnv("RAID_PAUSE_MINUTES", 10),
    },
  };
}

function missingKeys() {
  return missingRequired(getStore().getServerSettings()).map((setting) => setting.label);
}

let cachedConfig = null;

function getConfig() {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

function clearConfigCache() {
  cachedConfig = null;
}

function importIdSettingsFromEnv() {
  const imported = getStore().importServerSettingsOnce(importsFromEnv(process.env));
  if (imported?.length) {
    console.log(`Copied these settings from .env into the database (change them with /settings): ${imported.join(", ")}`);
  }
  cachedConfig = null;
}

const ENV_PATH = process.env.ENV_FILE || path.join(__dirname, "..", "..", ".env");

const EDITABLE_SETTINGS = {
  STRICT_VERIFICATION: { label: "Strict verification", type: "bool" },
  MIN_LEVEL: { label: "Min level", min: 1, max: 100, unit: "" },
  MIN_GS: { label: "Min gear score", min: 0, max: 100000, unit: "" },
  MIN_ACCOUNT_AGE_DAYS: { label: "Min account age", min: 0, max: 3650, unit: " days" },
  ARCHIVED_TICKET_RETENTION_DAYS: { label: "Archived tickets kept", min: 1, max: 365, unit: " days" },
  DAILY_RECHECK_TIME: { label: "Daily re-check time", type: "time", optional: true },
  TIMESLOT_DURATION: { label: "Timeslot length", min: 5, max: 180, unit: " min" },
  TIMESLOT_MIN_HOURS_BEFORE_EVENT: { label: "Timeslots end before event", min: 0, max: 72, unit: " h" },
};

function updateSetting(key, value) {
  const setting = EDITABLE_SETTINGS[key];
  if (!setting) throw new Error(`${key} can't be changed from Discord`);
  if (setting.type === "bool") {
    if (typeof value !== "boolean") throw new Error(`${setting.label} must be true or false`);
  } else if (setting.type === "time") {
    const valid = value === "" ? setting.optional : parseTime(value) === value;
    if (!valid) {
      throw new Error(`${setting.label} must be a 24-hour time like 04:00${setting.optional ? ", or off" : ""}`);
    }
  } else if (!Number.isInteger(value) || value < setting.min || value > setting.max) {
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

module.exports = {
  loadConfig,
  getConfig,
  missingKeys,
  clearConfigCache,
  importIdSettingsFromEnv,
  parseLegionRoles,
  parseClassRoles,
  parseLookupSources,
  parseTime,
  EDITABLE_SETTINGS,
  updateSetting,
};
