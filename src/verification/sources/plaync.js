// Looks characters up on the official AION 2 site (plaync.com): a name search on one server, then profile and gear.
//   profileUrl      the official site's search for a name on this server (for when only the name is known)
//   pageUrl         the character's own page on the official site
//   findExactMatch  picks the character with exactly this name on this server out of the search results
//   parseProfile    turns the profile and gear replies into the bot's character fields
//   getJson         asks the official site for one reply and sorts out errors and rate limits
//   characterUrl    the address of one of the character endpoints (info, equipment)
//   fetchCharacter  searches for a name and reads the profile and gear of the exact match

const { getConfig } = require("../config");
const { createLimiter } = require("./limiter");

const LANGUAGE = "en-US";

const limiter = createLimiter(() => getConfig().plaync.minRequestGapMs);

function profileUrl(name) {
  const { baseUrl, region, serverId } = getConfig().plaync;
  return `${baseUrl}/en-us/characters/index?serverId=${serverId}&keyword=${encodeURIComponent(name)}&region=${region}`;
}

function pageUrl(serverId, characterId) {
  const { baseUrl, region } = getConfig().plaync;
  return `${baseUrl}/en-us/characters/${serverId}/${encodeURIComponent(characterId)}?region=${region}`;
}

function findExactMatch(data, name, serverId) {
  const wanted = name.toLowerCase();
  const hit = (data?.list ?? []).find(
    (entry) =>
      entry.serverId === serverId && String(entry.name).replace(/<[^>]*>/g, "").toLowerCase() === wanted
  );
  return hit ? { characterId: decodeURIComponent(hit.characterId), serverId: hit.serverId } : null;
}

function parseProfile(info, gear) {
  const profile = info?.profile;
  if (!profile?.characterId || !profile.characterName) throw new Error("reply is missing the profile");
  const equipmentList = gear?.equipment?.equipmentList;
  if (!Array.isArray(equipmentList)) throw new Error("reply is missing the equipment");

  const itemLevel = (info.stat?.statList ?? []).find((stat) => stat.type === "ItemLevel");

  const equipment = {};
  for (const item of equipmentList) {
    if (item.slotPosName) {
      equipment[item.slotPosName] = { id: item.id, name: item.name };
    }
  }

  const now = Date.now();
  return {
    characterId: profile.characterId,
    name: profile.characterName,
    level: profile.characterLevel,
    className: profile.className,
    faction: profile.raceName,
    server: profile.serverName,
    legion: profile.regionName || null,
    combatPower: profile.combatPower ?? null,
    gearScore: itemLevel ? itemLevel.value : null,
    equipment,
    profileUpdatedAt: now,
    equipmentUpdatedAt: now,
    url: pageUrl(profile.serverId, profile.characterId),
    source: "plaync",
  };
}

async function getJson(url) {
  const { userAgent, requestTimeoutMs } = getConfig().lookup;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    return { status: "unavailable", reason: `network: ${error.message}` };
  }

  if (res.status === 404) return { status: "not_found" };

  if (res.status === 429) {
    const retryAfterSeconds = Number(res.headers.get("retry-after")) || 60;
    limiter.pause(retryAfterSeconds * 1000);
    return { status: "unavailable", reason: "rate_limited" };
  }

  if (res.status !== 200) return { status: "unavailable", reason: `http ${res.status}` };

  try {
    return { status: "ok", data: await res.json() };
  } catch (error) {
    return { status: "unavailable", reason: `parse: ${error.message}` };
  }
}

function characterUrl(endpoint, characterId) {
  const { baseUrl, region, serverId } = getConfig().plaync;
  const url = new URL(`${baseUrl}/api/character/${endpoint}`);
  url.search = new URLSearchParams({ lang: LANGUAGE, characterId, serverId, region }).toString();
  return url.toString();
}

async function fetchCharacter(name) {
  if (limiter.isPaused()) {
    return { status: "unavailable", reason: "rate_limited" };
  }

  const { searchUrl, region, serverId } = getConfig().plaync;
  const search = new URL(searchUrl);
  search.search = new URLSearchParams({ keyword: name, region, localeInfo: LANGUAGE, serverId }).toString();
  const found = await getJson(search.toString());
  if (found.status !== "ok") return found;

  const match = findExactMatch(found.data, name, serverId);
  if (!match) return { status: "not_found" };

  const info = await getJson(characterUrl("info", match.characterId));
  if (info.status !== "ok") return info;
  const gear = await getJson(characterUrl("equipment", match.characterId));
  if (gear.status !== "ok") return gear;

  try {
    return { status: "found", character: parseProfile(info.data, gear.data) };
  } catch (error) {
    return { status: "unavailable", reason: `parse: ${error.message}` };
  }
}

module.exports = {
  name: "plaync",
  label: "aion2.plaync.com",
  minRequestGapMs: () => getConfig().plaync.minRequestGapMs,
  lookup: (name) => limiter.run(() => fetchCharacter(name)),
  reset: () => limiter.reset(),
  profileUrl,
  pageUrl,
  findExactMatch,
  parseProfile,
};
