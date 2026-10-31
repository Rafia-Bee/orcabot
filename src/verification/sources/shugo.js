const { getConfig } = require("../config");
const { createLimiter } = require("./limiter");

const PROFILE_JSON_RE =
  /<script type="application\/json" id="shugo-profile">([\s\S]*?)<\/script>/;

const limiter = createLimiter(() => getConfig().shugo.minRequestGapMs);

function profileUrl(name) {
  const { baseUrl, regionPath } = getConfig().shugo;
  return `${baseUrl}/${regionPath}/${encodeURIComponent(name)}`;
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
    characterId: null,
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
  if (limiter.isPaused()) {
    return { status: "unavailable", reason: "rate_limited" };
  }

  const { userAgent, requestTimeoutMs } = getConfig().lookup;
  const url = profileUrl(name);
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
    limiter.pause(resetSeconds * 1000);
    return { status: "unavailable", reason: "rate_limited" };
  }

  if (res.status !== 200) {
    return { status: "unavailable", reason: `http ${res.status}` };
  }

  try {
    const character = parseProfile(await res.text());
    return { status: "found", character: { ...character, url, source: "shugo" } };
  } catch (error) {
    return { status: "unavailable", reason: `parse: ${error.message}` };
  }
}

module.exports = {
  name: "shugo",
  label: "shugo.gg",
  minRequestGapMs: () => getConfig().shugo.minRequestGapMs,
  lookup: (name) => limiter.run(() => fetchCharacter(name)),
  reset: () => limiter.reset(),
  profileUrl,
  parseProfile,
};
