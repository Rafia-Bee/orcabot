const { EmbedBuilder, escapeMarkdown } = require("discord.js");
const { getConfig } = require("./config");
const { OUTCOMES, DAY_MS } = require("./rules");

const COLORS = {
  green: 0x2ecc71,
  blue: 0x3498db,
  yellow: 0xf1c40f,
  red: 0xe74c3c,
  grey: 0x95a5a6,
};

const OUTCOME_STYLE = {
  [OUTCOMES.VERIFY]: { would: "verify", done: "Verified", color: COLORS.green },
  [OUTCOMES.TICKET]: { would: "open a review ticket", done: "Review ticket opened", color: COLORS.blue },
  [OUTCOMES.REVIEW]: { would: "send to mod review", done: "Sent to mod review", color: COLORS.yellow },
  [OUTCOMES.DENY]: { would: "deny", done: "Denied", color: COLORS.red },
  [OUTCOMES.RETRY]: { would: "ask the member to retry", done: "Asked to retry", color: COLORS.grey },
};

const REASON_TEXT = {
  passed: "All checks passed",
  invalid_name: "Not a valid character name",
  not_found: "Character not found",
  account_too_new: "Discord account is too new",
  shugo_unavailable: "shugo.gg lookup failed",
  wrong_faction: "Wrong faction",
  wrong_server: "Wrong server",
  level_too_low: "Level below minimum",
  gear_score_too_low: "Gear score below minimum",
  account_has_other_claim: "This Discord account already claimed a different character",
  name_already_claimed: "Character already claimed by another Discord account",
  recheck_not_found: "Re-check: character not found (renamed, transferred or deleted)",
  recheck_wrong_faction: "Re-check: character is now a different faction",
  recheck_wrong_server: "Re-check: character is now on a different server",
};

function reasonText(reason) {
  return REASON_TEXT[reason] ?? reason;
}

function unixSeconds(ms) {
  return Math.floor(ms / 1000);
}

function addCharacterFields(embed, character) {
  const c = character;
  const nameField = c.url ? `[${escapeMarkdown(c.name)}](${c.url})` : escapeMarkdown(c.name);
  embed.addFields(
    { name: "Character", value: c.className ? `${nameField} · ${c.className}` : nameField },
    { name: "Level", value: String(c.level ?? "?"), inline: true },
    { name: "Gear score", value: String(c.gearScore ?? "?"), inline: true },
    { name: "Combat power", value: c.combatPower?.toLocaleString("en-US") ?? "?", inline: true },
    { name: "Faction / Server", value: `${c.faction ?? "?"} / ${c.server ?? "?"}`, inline: true },
    { name: "Legion", value: c.legion ? escapeMarkdown(c.legion) : "—", inline: true }
  );
}

function buildSubmissionEmbed({ user, submittedName, lookup, decision, outcome, accountAgeMs }) {
  const cfg = getConfig();
  const style = OUTCOME_STYLE[outcome];
  const accountAgeDays = Math.floor(accountAgeMs / DAY_MS);
  const ageWarning = accountAgeDays < cfg.minAccountAgeDays ? " (below minimum)" : "";
  const title =
    cfg.mode === "shadow" ? `[Shadow] Would ${style.would}` : style.done;

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(title)
    .setDescription(`<@${user.id}> submitted **${escapeMarkdown(submittedName)}**`)
    .addFields(
      { name: "Reason", value: reasonText(decision.reason) },
      { name: "Account age", value: `${accountAgeDays} days${ageWarning}`, inline: true },
      { name: "User ID", value: user.id, inline: true }
    )
    .setTimestamp();

  if (lookup.status === "found") {
    addCharacterFields(embed, lookup.character);
  } else if (lookup.status === "unavailable") {
    embed.addFields({ name: "Lookup error", value: lookup.reason });
  }

  if (decision.details?.claimedBy) {
    embed.addFields({
      name: "Already claimed by",
      value: `<@${decision.details.claimedBy}> (${decision.details.claimedBy})`,
    });
  }
  if (decision.details?.claimedCharacter) {
    embed.addFields({
      name: "Previously claimed",
      value: escapeMarkdown(decision.details.claimedCharacter),
    });
  }
  return embed;
}

function buildEventEmbed({ color, title, description, fields = [] }) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    .setTimestamp();
}

async function postToChannel(client, channelId, payload) {
  try {
    const channel = await client.channels.fetch(channelId);
    return await channel.send({ allowedMentions: { parse: [] }, ...payload });
  } catch (error) {
    console.error(`Failed to post to channel ${channelId}:`, error);
    return null;
  }
}

function postLog(client, embed) {
  return postToChannel(client, getConfig().logChannelId, { embeds: [embed] });
}

module.exports = {
  COLORS,
  reasonText,
  unixSeconds,
  addCharacterFields,
  buildSubmissionEmbed,
  buildEventEmbed,
  postToChannel,
  postLog,
};
