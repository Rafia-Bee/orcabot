const { getConfig } = require("../config");
const { createLimiter } = require("./limiter");

const FACTIONS = { asmodian: "Asmodians", elyos: "Elyos" };
const REQUIRED_FIELDS = ["characterId", "name", "faction", "server", "level"];

const limiter = createLimiter(() => getConfig().aion2index.minRequestGapMs);

function profileUrl(name) {
  const { baseUrl, regionPath } = getConfig().aion2index;
  return `${new URL(baseUrl).origin}/c/${regionPath}/${encodeURIComponent(name)}`;
}

function apiUrl(name) {
  const { baseUrl, regionPath } = getConfig().aion2index;
  return `${baseUrl}/${regionPath}/${encodeURIComponent(name)}`;
}

function parseCharacter(data) {
  if (!data || typeof data !== "object") throw new Error("response is not a JSON object");
  const missing = REQUIRED_FIELDS.filter((key) => data[key] == null);
  if (missing.length) throw new Error(`response is missing ${missing.join(", ")}`);

  const updatedAt = Date.parse(data.updatedAt) || null;
  return {
    characterId: data.characterId,
    name: data.name,
    level: data.level,
    className: data.class ?? null,
    faction: FACTIONS[String(data.faction).toLowerCase()] ?? data.faction,
    server: data.server,
    legion: data.legion || null,
    combatPower: data.combatPower ?? null,
    gearScore: data.itemLevel ?? null,
    equipment: {},
    profileUpdatedAt: updatedAt,
    equipmentUpdatedAt: updatedAt,
    url: data.profileUrl || profileUrl(data.name),
    source: "aion2index",
  };
}

async function errorCode(res) {
  try {
    return (await res.json())?.error?.code ?? null;
  } catch {
    return null;
  }
}

async function fetchCharacter(name, { allowStale = false } = {}) {
  if (limiter.isPaused()) {
    return { status: "unavailable", reason: "rate_limited" };
  }

  const { userAgent, requestTimeoutMs } = getConfig().lookup;
  let res;
  try {
    res = await fetch(apiUrl(name), {
      headers: {
        Authorization: `Bearer ${getConfig().aion2index.apiKey}`,
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    return { status: "unavailable", reason: `network: ${error.message}` };
  }

  if (res.status === 404) return { status: "not_found" };

  if (res.status === 401 || res.status === 403) {
    const code = (await errorCode(res)) ?? `http ${res.status}`;
    return { status: "unavailable", reason: `API key rejected (${code})`, authFailed: true };
  }

  if (res.status === 429) {
    const code = (await errorCode(res)) ?? "rate_limited";
    const retryAfterSeconds = Number(res.headers.get("retry-after")) || 60;
    limiter.pause(retryAfterSeconds * 1000);
    return { status: "unavailable", reason: code };
  }

  if (res.status !== 200) {
    return { status: "unavailable", reason: `http ${res.status}` };
  }

  let data;
  let character;
  try {
    data = await res.json();
    character = parseCharacter(data);
  } catch (error) {
    return { status: "unavailable", reason: `parse: ${error.message}` };
  }

  if (data.fresh !== true && !allowStale) {
    const from = character.profileUpdatedAt
      ? new Date(character.profileUpdatedAt).toISOString()
      : "an unknown time";
    return { status: "unavailable", reason: `stale data from ${from} (game not answering)` };
  }
  return { status: "found", character };
}

module.exports = {
  name: "aion2index",
  label: "aion2index",
  minRequestGapMs: () => getConfig().aion2index.minRequestGapMs,
  lookup: (name, options) => limiter.run(() => fetchCharacter(name, options)),
  reset: () => limiter.reset(),
  profileUrl,
  parseCharacter,
};
