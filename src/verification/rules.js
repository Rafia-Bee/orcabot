const DAY_MS = 24 * 60 * 60 * 1000;

const OUTCOMES = {
  VERIFY: "verify",
  TICKET: "ticket",
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

  if (ownClaim && !same(ownClaim.char_name, character.name)) {
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

module.exports = { decide, OUTCOMES, DAY_MS };
