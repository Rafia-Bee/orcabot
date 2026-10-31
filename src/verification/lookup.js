const EventEmitter = require("events");
const { getConfig } = require("./config");

const SOURCES = {
  aion2index: require("./sources/aion2index"),
  shugo: require("./sources/shugo"),
};

const AUTH_ALERT_INTERVAL_MS = 60 * 60 * 1000;

const lookupEvents = new EventEmitter();
const cache = new Map();
const downUntil = new Map();
let lastAuthAlertAt = 0;

function configuredSources() {
  return getConfig().lookup.sources.map((name) => SOURCES[name]);
}

function primarySource() {
  return configuredSources()[0];
}

function characterUrl(name) {
  return primarySource().profileUrl(name);
}

function isValidName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= getConfig().maxNameLength &&
    !/[\s/\\?#%]/.test(name)
  );
}

function isDown(source) {
  return (downUntil.get(source.name) ?? 0) > Date.now();
}

async function lookupFrom(source, name) {
  const result = await source.lookup(name);
  if (result.status === "unavailable") {
    const wasDown = downUntil.has(source.name);
    downUntil.set(source.name, Date.now() + getConfig().lookup.failoverMinutes * 60_000);
    if (!wasDown) lookupEvents.emit("down", { source: source.label, reason: result.reason });
    if (result.authFailed && Date.now() - lastAuthAlertAt > AUTH_ALERT_INTERVAL_MS) {
      lastAuthAlertAt = Date.now();
      lookupEvents.emit("auth_failed", { source: source.label, reason: result.reason });
    }
  } else if (downUntil.has(source.name)) {
    downUntil.delete(source.name);
    lookupEvents.emit("up", { source: source.label });
  }
  return result;
}

async function lookupFromSources(name) {
  const sources = configuredSources();
  const up = sources.filter((source) => !isDown(source));
  const down = sources.filter((source) => isDown(source));
  const failures = [];
  let notFound = false;

  for (const source of up) {
    const result = await lookupFrom(source, name);
    if (result.status === "found") return result;
    if (result.status === "not_found") notFound = true;
    else failures.push(`${source.label}: ${result.reason}`);
  }
  if (notFound) return { status: "not_found" };

  for (const source of down) {
    const result = await lookupFrom(source, name);
    if (result.status !== "unavailable") return result;
    failures.push(`${source.label}: ${result.reason}`);
  }
  return { status: "unavailable", reason: failures.join("; ") };
}

async function lookupCharacter(rawName, { fresh = false } = {}) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!isValidName(name)) return { status: "invalid_name" };

  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await lookupFromSources(name);
  if (result.status !== "unavailable") {
    if (cache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    }
    cache.set(key, { result, expiresAt: Date.now() + getConfig().lookup.cacheTtlMs });
  }
  return result;
}

function resetLookupState() {
  cache.clear();
  downUntil.clear();
  lastAuthAlertAt = 0;
  for (const source of Object.values(SOURCES)) source.reset();
}

module.exports = {
  SOURCES,
  lookupCharacter,
  lookupEvents,
  isValidName,
  characterUrl,
  primarySource,
  configuredSources,
  resetLookupState,
};
