const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require("discord.js");
const { loadConfig } = require("./config");
const { getStore } = require("./store");
const { lookupCharacter } = require("./shugo");
const { decide, OUTCOMES, DAY_MS } = require("./rules");

const CUSTOM_ID_PREFIX = "verify";
const OPEN_BUTTON_ID = "verify:open";
const SUBMIT_MODAL_ID = "verify:submit";
const NAME_INPUT_ID = "character_name";

const OUTCOME_STYLE = {
  [OUTCOMES.VERIFY]: { label: "verify", emoji: "✅", color: 0x2ecc71 },
  [OUTCOMES.CHALLENGE]: { label: "send a gear challenge", emoji: "🧪", color: 0x3498db },
  [OUTCOMES.REVIEW]: { label: "send to mod review", emoji: "🕵️", color: 0xf1c40f },
  [OUTCOMES.DENY]: { label: "deny", emoji: "⛔", color: 0xe74c3c },
  [OUTCOMES.RETRY]: { label: "ask the member to retry", emoji: "↩️", color: 0x95a5a6 },
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
  gear_check_always: "Gear check required for everyone (GEAR_CHECK=always)",
};

let config = null;
function getConfig() {
  if (!config) config = loadConfig();
  return config;
}

function buildVerifyPanel() {
  const cfg = getConfig();
  const embed = new EmbedBuilder()
    .setTitle("Faction verification")
    .setColor(0x5865f2)
    .setDescription(
      [
        `This server is for **${cfg.requiredFaction}** on **${cfg.requiredServer}** only.`,
        "",
        "Click **Verify** and enter your in-game character name. " +
          "Our team will confirm your character and unlock the server for you.",
        "",
        `**Requirements:** Level ${cfg.minLevel}+, gear score ${cfg.minGearScore}+.`,
      ].join("\n")
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(OPEN_BUTTON_ID)
      .setLabel("Verify")
      .setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

function buildNameModal() {
  const cfg = getConfig();
  return new ModalBuilder()
    .setCustomId(SUBMIT_MODAL_ID)
    .setTitle("Verify your character")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("In-game character name")
        .setDescription(`Exactly as shown in AION 2 (${cfg.requiredServer})`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(NAME_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(32)
            .setRequired(true)
        )
    );
}

function memberMessage(decision, submittedName, lookup) {
  const name = escapeMarkdown(
    lookup.status === "found" ? lookup.character.name : submittedName
  );
  const cfg = getConfig();
  if (decision.reason === "invalid_name") {
    return "That doesn't look like a valid character name. Check it and try again.";
  }
  if (decision.reason === "not_found") {
    return (
      `We couldn't find **${name}** on ${cfg.requiredServer}. ` +
      "Check the spelling, including capital letters and special characters, and submit again."
    );
  }
  return `Thanks! Your request for **${name}** has been received. A moderator will verify you shortly.`;
}

function buildLogEmbed({ user, submittedName, lookup, decision, accountAgeMs }) {
  const cfg = getConfig();
  const style = OUTCOME_STYLE[decision.outcome];
  const accountAgeDays = Math.floor(accountAgeMs / DAY_MS);
  const ageWarning = accountAgeDays < cfg.minAccountAgeDays ? " ⚠" : "";
  const prefix = cfg.mode === "shadow" ? "[Shadow] Would " : "";

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.emoji} ${prefix}${style.label}`)
    .setDescription(`<@${user.id}> submitted **${escapeMarkdown(submittedName)}**`)
    .addFields(
      { name: "Reason", value: REASON_TEXT[decision.reason] ?? decision.reason },
      { name: "Account age", value: `${accountAgeDays} days${ageWarning}`, inline: true },
      { name: "User ID", value: user.id, inline: true }
    )
    .setTimestamp();

  if (lookup.status === "found") {
    const c = lookup.character;
    embed.addFields(
      {
        name: "Character",
        value: `[${escapeMarkdown(c.name)}](${c.url}) · ${c.className}`,
      },
      { name: "Level", value: String(c.level), inline: true },
      { name: "Gear score", value: String(c.gearScore ?? "?"), inline: true },
      { name: "Combat power", value: c.combatPower?.toLocaleString("en-US") ?? "?", inline: true },
      { name: "Faction / Server", value: `${c.faction} / ${c.server}`, inline: true },
      { name: "Legion", value: c.legion ? escapeMarkdown(c.legion) : "—", inline: true }
    );
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

async function postLog(client, embed) {
  try {
    const channel = await client.channels.fetch(getConfig().logChannelId);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Failed to post to verification log channel:", error);
  }
}

async function handleSubmit(interaction) {
  const cfg = getConfig();
  const store = getStore();
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.member.roles.cache.has(cfg.verifiedRoleId)) {
    return interaction.editReply("You're already verified.");
  }

  const cooldownMs = store.getCooldownRemaining(userId);
  if (cooldownMs > 0) {
    return interaction.editReply(
      `Please wait ${Math.ceil(cooldownMs / 1000)} seconds before trying again.`
    );
  }
  if (store.getOpenReviewCase(userId)) {
    return interaction.editReply(
      "Your request is already waiting for a moderator. Please be patient."
    );
  }
  store.setCooldown(userId, cfg.submitCooldownSeconds * 1000);

  const submittedName = interaction.fields.getTextInputValue(NAME_INPUT_ID).trim();
  const lookup = await lookupCharacter(submittedName);
  if (lookup.status === "invalid_name") store.setCooldown(userId, 0);
  const accountAgeMs = Date.now() - interaction.user.createdTimestamp;
  const decision = decide({
    lookup,
    accountAgeMs,
    charClaim:
      lookup.status === "found"
        ? store.getVerificationByCharName(lookup.character.name)
        : null,
    ownClaim: store.getVerification(userId),
    discordId: userId,
    config: cfg,
  });

  await postLog(
    interaction.client,
    buildLogEmbed({ user: interaction.user, submittedName, lookup, decision, accountAgeMs })
  );
  return interaction.editReply(memberMessage(decision, submittedName, lookup));
}

async function handleComponent(interaction) {
  if (interaction.isButton() && interaction.customId === OPEN_BUTTON_ID) {
    return interaction.showModal(buildNameModal());
  }
  if (interaction.isModalSubmit() && interaction.customId === SUBMIT_MODAL_ID) {
    return handleSubmit(interaction);
  }
}

module.exports = {
  CUSTOM_ID_PREFIX,
  getConfig,
  buildVerifyPanel,
  handleComponent,
};
