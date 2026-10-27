function intFromEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${key} must be a number, got "${raw}"`);
  return value;
}

function listFromEnv(key, fallback) {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadConfig() {
  const mode = (process.env.VERIFY_MODE || "shadow").trim();
  if (!["shadow", "live"].includes(mode)) {
    throw new Error(`VERIFY_MODE must be "shadow" or "live", got "${mode}"`);
  }
  const gearCheck = (process.env.GEAR_CHECK || "risky_only").trim();
  if (!["risky_only", "always"].includes(gearCheck)) {
    throw new Error(`GEAR_CHECK must be "risky_only" or "always", got "${gearCheck}"`);
  }

  return {
    mode,
    verifiedRoleId: process.env.VERIFIED_ROLE_ID,
    verifyChannelId: process.env.VERIFY_CHANNEL_ID,
    logChannelId: process.env.VERIFY_LOG_CHANNEL_ID,
    reviewChannelId: process.env.VERIFY_REVIEW_CHANNEL_ID,
    requiredFaction: process.env.REQUIRED_FACTION || "Asmodians",
    requiredServer: process.env.REQUIRED_SERVER || "Israphel",
    minLevel: intFromEnv("MIN_LEVEL", 45),
    minGearScore: intFromEnv("MIN_GS", 2100),
    minAccountAgeDays: intFromEnv("MIN_ACCOUNT_AGE_DAYS", 90),
    gearCheck,
    challengeSlots: listFromEnv("CHALLENGE_SLOTS", ["Belt"]),
    challengeTtlMinutes: intFromEnv("CHALLENGE_TTL_MINUTES", 15),
    submitCooldownSeconds: intFromEnv("VERIFY_COOLDOWN_SECONDS", 60),
  };
}

function missingKeys(config) {
  const required = {
    VERIFIED_ROLE_ID: config.verifiedRoleId,
    VERIFY_CHANNEL_ID: config.verifyChannelId,
    VERIFY_LOG_CHANNEL_ID: config.logChannelId,
    VERIFY_REVIEW_CHANNEL_ID: config.reviewChannelId,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

module.exports = { loadConfig, missingKeys };
