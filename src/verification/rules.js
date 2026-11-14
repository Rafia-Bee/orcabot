const DAY_MS = 24 * 60 * 60 * 1000;

const OUTCOMES = {
  VERIFY: "verify",
  TICKET: "ticket",
  REVIEW: "review",
  DENY: "deny",
  RETRY: "retry",
};

function isSameCharacter(claim, character) {
  if (claim.character_id && character.characterId) {
    return claim.character_id === character.characterId;
  }
  return String(claim.char_name).toLowerCase() === String(character.name).toLowerCase();
}

function decide({ lookup, accountAgeMs, charClaim, ownClaim, discordId, config }) {
  if (lookup.status === "invalid_name") {
    return { outcome: OUTCOMES.RETRY, reason: "invalid_name" };
  }
  if (lookup.status === "not_found") {
    return { outcome: OUTCOMES.RETRY, reason: "not_found" };
  }

  const accountAgeDays = Math.floor(accountAgeMs / DAY_MS);
  const accountTooNew = accountAgeDays < config.minAccountAgeDays;

  if (lookup.status !== "found") {
    return {
      outcome: OUTCOMES.REVIEW,
      reason: "shugo_unavailable",
      details: { error: lookup.reason, accountAgeDays },
    };
  }

  const character = lookup.character;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  if (!same(character.faction, config.requiredFaction)) {
    return {
      outcome: OUTCOMES.DENY,
      reason: "wrong_faction",
      details: { faction: character.faction },
    };
  }
  if (!same(character.server, config.requiredServer)) {
    return {
      outcome: OUTCOMES.DENY,
      reason: "wrong_server",
      details: { server: character.server },
    };
  }

  const levelTooLow = character.level < config.minLevel;
  const gearScoreTooLow = character.gearScore == null || character.gearScore < config.minGearScore;

  if (levelTooLow || gearScoreTooLow) {
    return {
      outcome: accountTooNew || config.strictVerification ? OUTCOMES.DENY : OUTCOMES.TICKET,
      reason: levelTooLow ? "level_too_low" : "gear_score_too_low",
      details: {
        levelTooLow,
        gearScoreTooLow,
        level: character.level,
        minLevel: config.minLevel,
        gearScore: character.gearScore,
        minGearScore: config.minGearScore,
        accountAgeDays,
      },
    };
  }
  if (accountTooNew) {
    return {
      outcome: OUTCOMES.TICKET,
      reason: "account_too_new",
      details: { accountAgeDays, minAccountAgeDays: config.minAccountAgeDays },
    };
  }

  if (ownClaim && !isSameCharacter(ownClaim, character)) {
    return {
      outcome: OUTCOMES.REVIEW,
      reason: "account_has_other_claim",
      details: { claimedCharacter: ownClaim.char_name },
    };
  }
  if (charClaim && charClaim.discord_id !== discordId) {
    return {
      outcome: OUTCOMES.REVIEW,
      reason: "name_already_claimed",
      details: { claimedBy: charClaim.discord_id },
    };
  }

  return { outcome: OUTCOMES.VERIFY, reason: "passed" };
}

const RENAME_REASONS = ["recheck_not_found", "recheck_different_character"];

function offersRename(reason, claim) {
  return RENAME_REASONS.includes(reason) && Boolean(claim?.character_id);
}

function decideRename({ claim, lookup, charClaim, config }) {
  const result = (reason) => ({ ok: reason === "passed", reason });
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  if (!claim?.character_id) return result("no_saved_id");
  if (lookup.status === "invalid_name" || lookup.status === "not_found") return result(lookup.status);
  if (lookup.status !== "found") return result("unavailable");

  const character = lookup.character;
  if (character.characterId !== claim.character_id) return result("different_character");
  if (!same(character.faction, config.requiredFaction)) return result("wrong_faction");
  if (!same(character.server, config.requiredServer)) return result("wrong_server");
  if (charClaim && charClaim.discord_id !== claim.discord_id) return result("name_already_claimed");
  return result("passed");
}

function renameCandidate(claim, character) {
  if (!claim?.character_id || !character || character.characterId) return null;
  return String(character.name).toLowerCase() === String(claim.char_name).toLowerCase() ? null : character.name;
}

function confirmsRename({ claim, character, charClaim }) {
  if (!character?.characterId || character.characterId !== claim.character_id) return false;
  return !charClaim || charClaim.discord_id === claim.discord_id;
}

module.exports = {
  decide,
  decideRename,
  offersRename,
  renameCandidate,
  confirmsRename,
  isSameCharacter,
  OUTCOMES,
  DAY_MS,
};
