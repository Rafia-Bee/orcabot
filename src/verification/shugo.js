const BASE_URL = "https://shugo.gg/character";
const REGION_PATH = process.env.SHUGO_REGION_PATH || "global/eu-israphel";

const USER_AGENT = "OrcaBot/1.0 (Discord faction verification)";
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_GAP_MS = 3_000;
const CACHE_TTL_MS = 60_000;
const MAX_NAME_LENGTH = 32;

const PROFILE_JSON_RE =
  /<script type="application\/json" id="shugo-profile">([\s\S]*?)<\/script>/;

const cache = new Map();
let queue = Promise.resolve();
let nextRequestAt = 0;
let pausedUntil = 0;

function characterUrl(name) {
  return `${BASE_URL}/${REGION_PATH}/${encodeURIComponent(name)}`;
}

function isValidName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
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
      nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS;
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

  const url = characterUrl(name);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return result;
}

module.exports = { lookupCharacter, parseProfile, characterUrl };
