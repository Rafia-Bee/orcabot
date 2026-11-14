const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decide,
  decideRename,
  offersRename,
  renameCandidate,
  confirmsRename,
  DAY_MS,
} = require("../src/verification/rules");

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

test("a renamed character is still the member's own claim", () => {
  const ownClaim = { discord_id: "1", char_name: "OldName", character_id: "id-1" };
  const renamed = found({ name: "dieyoung", characterId: "id-1" });
  assert.equal(outcome({ ownClaim, lookup: renamed }), "verify:passed");
  assert.equal(
    outcome({ ownClaim, lookup: found({ characterId: "id-2" }) }),
    "review:account_has_other_claim"
  );
});

test("matching by ID wins over matching by name", () => {
  const ownClaim = { discord_id: "1", char_name: "dieyoung", character_id: "id-1" };
  assert.equal(
    outcome({ ownClaim, lookup: found({ characterId: "id-2" }) }),
    "review:account_has_other_claim"
  );
  assert.equal(outcome({ ownClaim: { ...ownClaim, character_id: null } }), "verify:passed");
});

test("re-check offers Rename only when the name vanished and we know the character ID", () => {
  const claim = { discord_id: "1", char_name: "OldName", character_id: "id-1" };
  assert.equal(offersRename("recheck_not_found", claim), true);
  assert.equal(offersRename("recheck_different_character", claim), true);
  assert.equal(offersRename("recheck_wrong_faction", claim), false);
  assert.equal(offersRename("recheck_not_found", { ...claim, character_id: null }), false);
  assert.equal(offersRename("recheck_not_found", null), false);
});

test("rename goes through only for the same character ID", () => {
  const claim = { discord_id: "1", char_name: "OldName", character_id: "id-1" };
  const rename = (extra = {}) =>
    decideRename({ claim, lookup: found({ name: "NewName", characterId: "id-1" }), charClaim: null, config, ...extra })
      .reason;

  assert.equal(rename(), "passed");
  assert.equal(rename({ lookup: found({ characterId: "id-2" }) }), "different_character");
  assert.equal(rename({ lookup: found({ characterId: null }) }), "different_character");
  assert.equal(rename({ claim: { ...claim, character_id: null } }), "no_saved_id");
  assert.equal(rename({ lookup: { status: "not_found" } }), "not_found");
  assert.equal(rename({ lookup: { status: "invalid_name" } }), "invalid_name");
  assert.equal(rename({ lookup: { status: "unavailable", reason: "http 500" } }), "unavailable");
  assert.equal(rename({ lookup: found({ characterId: "id-1", faction: "Elyos" }) }), "wrong_faction");
  assert.equal(rename({ lookup: found({ characterId: "id-1", server: "Lumiel" }) }), "wrong_server");
  assert.equal(rename({ charClaim: { discord_id: "2", char_name: "NewName" } }), "name_already_claimed");
  assert.equal(rename({ charClaim: { discord_id: "1", char_name: "NewName" } }), "passed");
});

test("a backup site showing a new name for the old one is a rename to check", () => {
  const claim = { discord_id: "1", char_name: "MommySage", character_id: "id-1" };
  const fromBackup = { name: "Lisaツ", characterId: null };
  assert.equal(renameCandidate(claim, fromBackup), "Lisaツ");
  assert.equal(renameCandidate(claim, { name: "mommysage", characterId: null }), null);
  assert.equal(renameCandidate(claim, { name: "Lisaツ", characterId: "id-2" }), null);
  assert.equal(renameCandidate({ ...claim, character_id: null }, fromBackup), null);
  assert.equal(renameCandidate(claim, null), null);
});

test("an automatic rename needs the same ID and a free name", () => {
  const claim = { discord_id: "1", char_name: "MommySage", character_id: "id-1" };
  const renamed = { name: "Lisaツ", characterId: "id-1" };
  assert.equal(confirmsRename({ claim, character: renamed, charClaim: null }), true);
  assert.equal(confirmsRename({ claim, character: { ...renamed, characterId: "id-2" }, charClaim: null }), false);
  assert.equal(confirmsRename({ claim, character: { ...renamed, characterId: null }, charClaim: null }), false);
  assert.equal(confirmsRename({ claim, character: null, charClaim: null }), false);
  assert.equal(confirmsRename({ claim, character: renamed, charClaim: { discord_id: "2" } }), false);
  assert.equal(confirmsRename({ claim, character: renamed, charClaim: { discord_id: "1" } }), true);
});

test("a passed rename says it's ok", () => {
  const claim = { discord_id: "1", char_name: "OldName", character_id: "id-1" };
  const lookup = found({ name: "NewName", characterId: "id-1" });
  assert.equal(decideRename({ claim, lookup, charClaim: null, config }).ok, true);
  assert.equal(decideRename({ claim, lookup: { status: "not_found" }, charClaim: null, config }).ok, false);
});
