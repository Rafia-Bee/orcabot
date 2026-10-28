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
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { lookupCharacter } = require("./shugo");
const { decide, OUTCOMES, DAY_MS } = require("./rules");
const { buildSubmissionEmbed, postLog, postToChannel, unixSeconds } = require("./embeds");
const { randomGrantDelayMs, startGrantSweeper } = require("./access");
const { openReviewCase, isReviewButton, handleReviewButton } = require("./review");
const { openTicket, isTicketButton, handleTicketButton } = require("./tickets");

const CUSTOM_ID_PREFIX = "verify";
const OPEN_BUTTON_ID = "verify:open";
const SUBMIT_MODAL_ID = "verify:submit";
const NAME_INPUT_ID = "character_name";

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
            .setMaxLength(cfg.maxNameLength)
            .setRequired(true)
        )
    );
}

function memberMessage(outcome, reason, name, ticketChannelId) {
  const cfg = getConfig();
  const safeName = escapeMarkdown(name);
  if (ticketChannelId) {
    return `Thanks! An officer needs to confirm **${safeName}** before you're verified. Please continue in <#${ticketChannelId}>.`;
  }
  if (reason === "invalid_name") {
    return "That doesn't look like a valid character name. Check it and try again.";
  }
  if (reason === "not_found") {
    return (
      `We couldn't find **${safeName}** on ${cfg.requiredServer}. ` +
      "Check the spelling, including capital letters and special characters, and submit again."
    );
  }
  if (cfg.mode === "live" && outcome === OUTCOMES.DENY) {
    if (reason === "wrong_faction" || reason === "wrong_server") {
      return `**${safeName}** isn't eligible. This server is for ${cfg.requiredFaction} on ${cfg.requiredServer} only.`;
    }
    return (
      `**${safeName}** doesn't meet the requirements yet ` +
      `(Level ${cfg.minLevel}+, gear score ${cfg.minGearScore}+). Submit again once it does.`
    );
  }
  return `Thanks! Your request for **${safeName}** has been received. A moderator will verify you shortly.`;
}

function scheduleVerifiedGrant(interaction, character) {
  const store = getStore();
  try {
    store.saveVerification({
      discordId: interaction.user.id,
      character,
      method: "auto",
    });
  } catch (error) {
    if (error.code === "CHAR_CLAIMED") return { claimedBy: error.claimedBy };
    throw error;
  }
  const dueAt = Date.now() + randomGrantDelayMs();
  store.scheduleGrant({
    discordId: interaction.user.id,
    guildId: interaction.guildId,
    charName: character.name,
    dueAt,
  });
  return { dueAt };
}

async function handleSubmit(interaction) {
  const cfg = getConfig();
  const store = getStore();
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.member.roles.cache.has(cfg.verifiedRoleId)) {
    return interaction.editReply("You're already verified.");
  }
  const openTicketForUser = store.getOpenTicket(userId);
  if (openTicketForUser) {
    return interaction.editReply(
      `Your request is being reviewed by an officer. Please continue in <#${openTicketForUser.channel_id}>.`
    );
  }
  if (store.getScheduledGrant(userId) || store.getOpenReviewCase(userId)) {
    return interaction.editReply(
      "Your request has already been received. A moderator will verify you shortly."
    );
  }
  const cooldownMs = store.getCooldownRemaining(userId);
  if (cooldownMs > 0) {
    return interaction.editReply(
      `Please wait ${Math.ceil(cooldownMs / 1000)} seconds before trying again.`
    );
  }
  store.setCooldown(userId, cfg.submitCooldownSeconds * 1000);

  const submittedName = interaction.fields.getTextInputValue(NAME_INPUT_ID).trim();
  const lookup = await lookupCharacter(submittedName);
  if (lookup.status === "invalid_name") store.setCooldown(userId, 0);
  const character = lookup.status === "found" ? lookup.character : null;
  const accountAgeMs = Date.now() - interaction.user.createdTimestamp;
  const decision = decide({
    lookup,
    accountAgeMs,
    charClaim: character ? store.getVerificationByCharName(character.name) : null,
    ownClaim: store.getVerification(userId),
    discordId: userId,
    config: cfg,
  });
  const displayName = character ? character.name : submittedName;

  let outcome = decision.outcome;
  let reason = decision.reason;
  const logFields = [];
  let ticketChannelId = null;

  if (cfg.mode === "live") {
    if (outcome === OUTCOMES.VERIFY) {
      const grant = scheduleVerifiedGrant(interaction, character);
      if (grant.claimedBy) {
        outcome = OUTCOMES.REVIEW;
        reason = "name_already_claimed";
        decision.details = { claimedBy: grant.claimedBy };
      } else {
        logFields.push({
          name: "Role granted",
          value: `<t:${unixSeconds(grant.dueAt)}:R>`,
          inline: true,
        });
      }
    }

    if (outcome === OUTCOMES.TICKET) {
      try {
        const ticket = await openTicket(interaction, { character, reason });
        ticketChannelId = ticket.channel_id;
        logFields.push({ name: "Ticket", value: `<#${ticket.channel_id}> (#${ticket.id})`, inline: true });
      } catch (error) {
        console.error("Failed to open verification ticket:", error);
        outcome = OUTCOMES.REVIEW;
        logFields.push({ name: "Ticket failed", value: error.message.slice(0, 1000) });
      }
    }

    if (outcome === OUTCOMES.REVIEW) {
      const reviewCase = await openReviewCase(interaction.client, {
        discordId: userId,
        charName: displayName,
        reason,
        character,
        context: {
          accountAgeDays: Math.floor(accountAgeMs / DAY_MS),
          lookupError: lookup.status === "unavailable" ? lookup.reason : null,
          details: decision.details,
        },
      });
      logFields.push({ name: "Review case", value: `#${reviewCase.id}`, inline: true });
    }
  }

  const logEmbed = buildSubmissionEmbed({
    user: interaction.user,
    submittedName,
    lookup,
    decision: { ...decision, reason },
    outcome,
    accountAgeMs,
  });
  if (logFields.length) logEmbed.addFields(logFields);
  if (ticketChannelId) {
    await postToChannel(interaction.client, cfg.reviewChannelId, { embeds: [logEmbed] });
  } else {
    await postLog(interaction.client, logEmbed);
  }

  return interaction.editReply(memberMessage(outcome, reason, displayName, ticketChannelId));
}

async function handleComponent(interaction) {
  if (interaction.isButton() && interaction.customId === OPEN_BUTTON_ID) {
    return interaction.showModal(buildNameModal());
  }
  if (interaction.isModalSubmit() && interaction.customId === SUBMIT_MODAL_ID) {
    return handleSubmit(interaction);
  }
  if (interaction.isButton() && isTicketButton(interaction.customId)) {
    return handleTicketButton(interaction);
  }
  if (interaction.isButton() && isReviewButton(interaction.customId)) {
    return handleReviewButton(interaction);
  }
}

function onReady(client) {
  const cfg = getConfig();
  console.log(`Verification mode: ${cfg.mode}`);
  startGrantSweeper(client);
}

module.exports = {
  CUSTOM_ID_PREFIX,
  buildVerifyPanel,
  handleComponent,
  onReady,
};
