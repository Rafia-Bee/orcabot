const test = require("node:test");
const assert = require("node:assert/strict");
const { decide, DAY_MS } = require("../src/verification/rules");

const config = {
  requiredFaction: "Asmodians",
  requiredServer: "Israphel",
  minLevel: 45,
  minGearScore: 2100,
  minAccountAgeDays: 90,
};

const found = (extra = {}) => ({
  status: "found",
  character: {
    name: "dieyoung",
    level: 45,
    faction: "Asmodians",
    server: "Israphel",
    gearScore: 3500,
    ...extra,
  },
});

const input = (extra = {}) => ({
  lookup: found(),
  accountAgeMs: 365 * DAY_MS,
  charClaim: null,
  ownClaim: null,
  discordId: "1",
  config,
  ...extra,
});

const outcome = (extra) => {
  const { outcome, reason } = decide(input(extra));
  return `${outcome}:${reason}`;
};

test("clean pass verifies", () => {
  assert.equal(outcome(), "verify:passed");
});

test("bad input asks the member to retry, even for young accounts", () => {
  assert.equal(outcome({ lookup: { status: "invalid_name" } }), "retry:invalid_name");
  assert.equal(
    outcome({ lookup: { status: "not_found" }, accountAgeMs: DAY_MS }),
    "retry:not_found"
  );
});

test("young account with a valid character gets a ticket", () => {
  assert.equal(outcome({ accountAgeMs: 89 * DAY_MS }), "ticket:account_too_new");
  assert.equal(outcome({ accountAgeMs: 90 * DAY_MS }), "verify:passed");
});

test("young account with a weak or wrong character is denied", () => {
  const young = { accountAgeMs: DAY_MS };
  assert.equal(outcome({ ...young, lookup: found({ level: 44 }) }), "deny:level_too_low");
  assert.equal(outcome({ ...young, lookup: found({ gearScore: 2000 }) }), "deny:gear_score_too_low");
  assert.equal(outcome({ ...young, lookup: found({ faction: "Elyos" }) }), "deny:wrong_faction");
});

test("site trouble goes to review, never deny", () => {
  assert.equal(
    outcome({ lookup: { status: "unavailable", reason: "http 500" } }),
    "review:shugo_unavailable"
  );
  assert.equal(
    outcome({ lookup: { status: "unavailable", reason: "http 500" }, accountAgeMs: DAY_MS }),
    "review:shugo_unavailable"
  );
});

test("faction and server are denied, low level or gear score gets a ticket", () => {
  assert.equal(outcome({ lookup: found({ faction: "Elyos" }) }), "deny:wrong_faction");
  assert.equal(outcome({ lookup: found({ faction: "asmodians" }) }), "verify:passed");
  assert.equal(outcome({ lookup: found({ server: "Lumiel" }) }), "deny:wrong_server");
  assert.equal(outcome({ lookup: found({ level: 44 }) }), "ticket:level_too_low");
  assert.equal(outcome({ lookup: found({ gearScore: 2099 }) }), "ticket:gear_score_too_low");
  assert.equal(outcome({ lookup: found({ gearScore: 2100 }) }), "verify:passed");
  assert.equal(outcome({ lookup: found({ gearScore: null }) }), "ticket:gear_score_too_low");
});

test("strict verification denies low level or gear score instead of a ticket", () => {
  const strict = { ...config, strictVerification: true };
  assert.equal(outcome({ config: strict, lookup: found({ level: 44 }) }), "deny:level_too_low");
  assert.equal(outcome({ config: strict, lookup: found({ gearScore: 2000 }) }), "deny:gear_score_too_low");
  assert.equal(outcome({ config: strict }), "verify:passed");
  assert.equal(outcome({ config: strict, accountAgeMs: DAY_MS }), "ticket:account_too_new");
});

test("both level and gear score too low are reported", () => {
  const { details } = decide(input({ lookup: found({ level: 40, gearScore: 1000 }) }));
  assert.equal(details.levelTooLow, true);
  assert.equal(details.gearScoreTooLow, true);
});

test("claims", () => {
  assert.equal(
    outcome({ charClaim: { discord_id: "2", char_name: "dieyoung" } }),
    "review:name_already_claimed"
  );
  assert.equal(
    outcome({
      charClaim: { discord_id: "1", char_name: "dieyoung" },
      ownClaim: { discord_id: "1", char_name: "dieyoung" },
    }),
    "verify:passed"
  );
  assert.equal(
    outcome({ ownClaim: { discord_id: "1", char_name: "SomeoneElse" } }),
    "review:account_has_other_claim"
  );
});
