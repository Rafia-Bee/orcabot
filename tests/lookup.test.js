const test = require("node:test");
const assert = require("node:assert/strict");

Object.assign(process.env, {
  REQUIRED_FACTION: "Asmodians",
  REQUIRED_SERVER: "Israphel",
  MIN_LEVEL: "45",
  MIN_GS: "2100",
  MIN_ACCOUNT_AGE_DAYS: "90",
  TICKET_GEAR_SLOTS: "Helmet,Boots",
  MAX_CHARACTER_NAME_LENGTH: "32",
  ARCHIVED_TICKET_RETENTION_DAYS: "7",
  STRICT_VERIFICATION: "false",
  SHUGO_BASE_URL: "https://shugo.test/character",
  SHUGO_REGION_PATH: "global/eu-israphel",
  SHUGO_USER_AGENT: "OrcaBot test",
  SHUGO_REQUEST_TIMEOUT_MS: "1000",
  SHUGO_MIN_REQUEST_GAP_MS: "0",
  SHUGO_CACHE_TTL_MS: "60000",
  LOOKUP_SOURCES: "aion2index,shugo",
  LOOKUP_FAILOVER_MINUTES: "5",
  AION2INDEX_API_KEY: "test-key",
  AION2INDEX_BASE_URL: "https://a2i.test/api/v1/characters",
  AION2INDEX_REGION_PATH: "eu/israphel",
  AION2INDEX_MIN_REQUEST_GAP_MS: "0",
});

const { parseLookupSources } = require("../src/verification/config");
const { lookupCharacter, lookupEvents, resetLookupState } = require("../src/verification/lookup");
const { parseCharacter } = require("../src/verification/sources/aion2index");

const apiCharacter = (extra = {}) => ({
  characterId: "abc123=",
  name: "KFC",
  region: "eu",
  server: "Israphel",
  serverSlug: "israphel",
  faction: "asmodian",
  class: "Cleric",
  level: 45,
  itemLevel: 1686,
  combatPower: 81337,
  legion: "Aegis",
  title: { name: "Stomach Filling", grade: "Legend" },
  profileUrl: "https://a2i.test/c/eu/israphel/KFC",
  updatedAt: "2026-10-30T21:55:45.108Z",
  fresh: true,
  ...extra,
});

const shugoPage = () => {
  const data = {
    info: {
      __updatedAt: 1,
      profile: {
        characterName: "KFC",
        characterLevel: 45,
        className: "Cleric",
        raceName: "Asmodians",
        serverName: "Israphel",
        regionName: "Aegis",
        combatPower: 72819,
      },
      stat: { statList: [{ type: "ItemLevel", value: 1642 }] },
    },
    equipment: { __updatedAt: 1, equipment: { equipmentList: [{ slotPosName: "Helmet", id: 1, name: "Helm" }] } },
  };
  return `<script type="application/json" id="shugo-profile">${JSON.stringify(data)}</script>`;
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let calls;
let replies;

function fakeFetch(url, options) {
  const site = url.startsWith("https://a2i.test") ? "aion2index" : "shugo";
  calls.push({ site, url, options });
  const reply = replies[site];
  if (reply instanceof Error) return Promise.reject(reply);
  return Promise.resolve(typeof reply === "function" ? reply() : reply);
}

const ok = {
  aion2index: () => json(200, apiCharacter()),
  shugo: () => new Response(shugoPage(), { status: 200 }),
};
const notFound = {
  aion2index: () => json(404, { error: { code: "not_found", message: "No such character." } }),
  shugo: () => new Response("", { status: 404 }),
};
const serverError = () => new Response("", { status: 500 });

test.beforeEach(() => {
  resetLookupState();
  lookupEvents.removeAllListeners();
  calls = [];
  replies = { ...ok };
  globalThis.fetch = fakeFetch;
});

const sitesCalled = () => calls.map((call) => call.site);

test("maps an aion2index response to the bot's character fields", () => {
  const c = parseCharacter(apiCharacter());
  assert.equal(c.characterId, "abc123=");
  assert.equal(c.faction, "Asmodians");
  assert.equal(c.className, "Cleric");
  assert.equal(c.gearScore, 1686);
  assert.equal(c.legion, "Aegis");
  assert.deepEqual(c.equipment, {});
  assert.equal(c.source, "aion2index");
  assert.equal(parseCharacter(apiCharacter({ faction: "elyos" })).faction, "Elyos");
  assert.equal(parseCharacter(apiCharacter({ legion: null })).legion, null);
  assert.throws(() => parseCharacter(apiCharacter({ characterId: null })), /missing characterId/);
});

test("parses LOOKUP_SOURCES", () => {
  assert.deepEqual(parseLookupSources("aion2index, shugo"), ["aion2index", "shugo"]);
  assert.deepEqual(parseLookupSources(undefined), ["shugo"]);
  assert.throws(() => parseLookupSources("shugo,other"), /unknown site "other"/);
  assert.throws(() => parseLookupSources("shugo,shugo"), /twice/);
  assert.throws(() => parseLookupSources(" , "), /at least one/);
});

test("uses the primary site and sends the API key", async () => {
  const result = await lookupCharacter("KFC");
  assert.equal(result.status, "found");
  assert.equal(result.character.source, "aion2index");
  assert.deepEqual(sitesCalled(), ["aion2index"]);
  assert.equal(calls[0].url, "https://a2i.test/api/v1/characters/eu/israphel/KFC");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
});

test("falls back when the primary is down, then skips it during the failover window", async () => {
  const events = [];
  lookupEvents.on("down", (event) => events.push(event.source));
  replies.aion2index = serverError;

  const first = await lookupCharacter("KFC");
  assert.equal(first.character.source, "shugo");
  assert.deepEqual(events, ["aion2index"]);

  const second = await lookupCharacter("Other", { fresh: true });
  assert.equal(second.status, "found");
  assert.deepEqual(sitesCalled(), ["aion2index", "shugo", "shugo"]);
  assert.deepEqual(events, ["aion2index"]);
});

test("a down site that answers again is used and reported", async () => {
  const events = [];
  lookupEvents.on("up", (event) => events.push(event.source));
  replies.aion2index = serverError;
  await lookupCharacter("KFC");

  replies.aion2index = ok.aion2index;
  replies.shugo = serverError;
  const result = await lookupCharacter("KFC", { fresh: true });
  assert.equal(result.character.source, "aion2index");
  assert.deepEqual(events, ["aion2index"]);
});

test("stale aion2index data is not used", async () => {
  replies.aion2index = () => json(200, apiCharacter({ fresh: false }));
  const result = await lookupCharacter("KFC");
  assert.equal(result.character.source, "shugo");

  resetLookupState();
  replies.shugo = serverError;
  const bothDown = await lookupCharacter("KFC");
  assert.equal(bothDown.status, "unavailable");
  assert.match(bothDown.reason, /aion2index: stale data from 2026-10-30T21:55:45.108Z/);
  assert.match(bothDown.reason, /shugo.gg: http 500/);
});

test("not found on the primary asks the backup, and trusts two not-founds", async () => {
  replies.aion2index = notFound.aion2index;
  const hidden = await lookupCharacter("KFC");
  assert.equal(hidden.character.source, "shugo");

  replies.shugo = notFound.shugo;
  const missing = await lookupCharacter("Nobody");
  assert.equal(missing.status, "not_found");
});

test("not found on the primary doesn't wait for a site that is down", async () => {
  replies.shugo = serverError;
  replies.aion2index = serverError;
  await lookupCharacter("KFC");
  calls = [];

  replies.aion2index = notFound.aion2index;
  const result = await lookupCharacter("Nobody", { fresh: true });
  assert.equal(result.status, "not_found");
  assert.deepEqual(sitesCalled(), ["aion2index"]);
});

test("a rejected API key raises one alert", async () => {
  const alerts = [];
  lookupEvents.on("auth_failed", (event) => alerts.push(event.reason));
  replies.aion2index = () => json(401, { error: { code: "invalid_key", message: "nope" } });

  const result = await lookupCharacter("KFC");
  assert.equal(result.character.source, "shugo");
  await lookupCharacter("KFC", { fresh: true });
  assert.deepEqual(alerts, ["API key rejected (invalid_key)"]);
});

test("a rate-limited site isn't asked again until retry-after", async () => {
  replies.aion2index = () => json(429, { error: { code: "rate_limited" } }, { "retry-after": "30" });
  await lookupCharacter("KFC");
  replies.shugo = serverError;
  calls = [];

  const result = await lookupCharacter("Other");
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /aion2index: rate_limited/);
  assert.deepEqual(sitesCalled(), ["shugo"]);
});

test("invalid names never reach a site", async () => {
  assert.equal((await lookupCharacter("two words")).status, "invalid_name");
  assert.equal((await lookupCharacter("")).status, "invalid_name");
  assert.deepEqual(calls, []);
});
