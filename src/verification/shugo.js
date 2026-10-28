const { getConfig } = require("./config");

const PROFILE_JSON_RE =
  /<script type="application\/json" id="shugo-profile">([\s\S]*?)<\/script>/;

const cache = new Map();
let queue = Promise.resolve();
let nextRequestAt = 0;
let pausedUntil = 0;

function characterUrl(name) {
  const { baseUrl, regionPath } = getConfig().shugo;
  return `${baseUrl}/${regionPath}/${encodeURIComponent(name)}`;
}

function isValidName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= getConfig().maxNameLength &&
    !/[\s/\\?#%]/.test(name)
  );
}

function enqueue(fn) {
  const run = queue.then(async () => {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fn();
    } finally {
      nextRequestAt = Date.now() + getConfig().shugo.minRequestGapMs;
    }
  });
  queue = run.catch(() => {});
  return run;
}

function parseProfile(html) {
  const match = html.match(PROFILE_JSON_RE);
  if (!match) throw new Error("shugo-profile JSON block not found");

  const data = JSON.parse(match[1]);
  const profile = data.info?.profile;
  const equipmentList = data.equipment?.equipment?.equipmentList;
  if (!profile || !Array.isArray(equipmentList)) {
    throw new Error("shugo-profile JSON is missing profile or equipment");
  }

  const statList = data.info.stat?.statList ?? [];
  const itemLevel = statList.find((stat) => stat.type === "ItemLevel");

  const equipment = {};
  for (const item of equipmentList) {
    if (item.slotPosName) {
      equipment[item.slotPosName] = { id: item.id, name: item.name };
    }
  }

  return {
    name: profile.characterName,
    level: profile.characterLevel,
    className: profile.className,
    faction: profile.raceName,
    server: profile.serverName,
    legion: profile.regionName || null,
    combatPower: profile.combatPower,
    gearScore: itemLevel ? itemLevel.value : null,
    equipment,
    profileUpdatedAt: data.info.__updatedAt,
    equipmentUpdatedAt: data.equipment.__updatedAt,
  };
}

async function fetchCharacter(name) {
  if (Date.now() < pausedUntil) {
    return { status: "unavailable", reason: "rate_limited" };
  }

  const { userAgent, requestTimeoutMs } = getConfig().shugo;
  const url = characterUrl(name);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": userAgent },
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    return { status: "unavailable", reason: `network: ${error.message}` };
  }

  if (res.status === 404) return { status: "not_found" };

  if (res.status === 429) {
    const resetSeconds = Number(res.headers.get("ratelimit-reset")) || 600;
    pausedUntil = Date.now() + resetSeconds * 1000;
    return { status: "unavailable", reason: "rate_limited" };
  }

  if (res.status !== 200) {
    return { status: "unavailable", reason: `http ${res.status}` };
  }

  try {
    const character = parseProfile(await res.text());
    return { status: "found", character: { ...character, url } };
  } catch (error) {
    return { status: "unavailable", reason: `parse: ${error.message}` };
  }
}

async function lookupCharacter(rawName, { fresh = false } = {}) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!isValidName(name)) return { status: "invalid_name" };

  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await enqueue(() => fetchCharacter(name));
  if (result.status !== "unavailable") {
    if (cache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    }
    cache.set(key, { result, expiresAt: Date.now() + getConfig().shugo.cacheTtlMs });
  }
  return result;
}

module.exports = { lookupCharacter, parseProfile, characterUrl };
