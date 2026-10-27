const DAY_MS = 24 * 60 * 60 * 1000;

const OUTCOMES = {
  VERIFY: "verify",
  CHALLENGE: "challenge",
  REVIEW: "review",
  DENY: "deny",
  RETRY: "retry",
};

function decide({ lookup, accountAgeMs, charClaim, ownClaim, discordId, config }) {
  if (lookup.status === "invalid_name") {
    return { outcome: OUTCOMES.RETRY, reason: "invalid_name" };
  }
  if (lookup.status === "not_found") {
    return { outcome: OUTCOMES.RETRY, reason: "not_found" };
  }

  const accountAgeDays = Math.floor(accountAgeMs / DAY_MS);
  if (accountAgeDays < config.minAccountAgeDays) {
    return {
      outcome: OUTCOMES.REVIEW,
      reason: "account_too_new",
      details: { accountAgeDays, minAccountAgeDays: config.minAccountAgeDays },
    };
  }

  if (lookup.status !== "found") {
    return {
      outcome: OUTCOMES.REVIEW,
      reason: "shugo_unavailable",
      details: { error: lookup.reason },
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
  if (character.level < config.minLevel) {
    return {
      outcome: OUTCOMES.DENY,
      reason: "level_too_low",
      details: { level: character.level, minLevel: config.minLevel },
    };
  }
  if (character.gearScore == null || character.gearScore < config.minGearScore) {
    return {
      outcome: OUTCOMES.DENY,
      reason: "gear_score_too_low",
      details: { gearScore: character.gearScore, minGearScore: config.minGearScore },
    };
  }

  if (ownClaim && !same(ownClaim.char_name, character.name)) {
    return {
      outcome: OUTCOMES.REVIEW,
      reason: "account_has_other_claim",
      details: { claimedCharacter: ownClaim.char_name },
    };
  }

  if (charClaim && charClaim.discord_id !== discordId) {
    return {
      outcome: OUTCOMES.CHALLENGE,
      reason: "name_already_claimed",
      details: { claimedBy: charClaim.discord_id },
    };
  }

  if (config.gearCheck === "always") {
    return { outcome: OUTCOMES.CHALLENGE, reason: "gear_check_always" };
  }

  return { outcome: OUTCOMES.VERIFY, reason: "passed" };
}

module.exports = { decide, OUTCOMES, DAY_MS };
