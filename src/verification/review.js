const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { grantAccess, revokeAccess, applyCharacterRoles, applyNickname, canRename } = require("./access");
const { isStaff } = require("./tickets");
const { lookupCharacter } = require("./lookup");
const { decideRename, offersRename } = require("./rules");
const {
  COLORS,
  reasonText,
  addCharacterFields,
  buildEventEmbed,
  postToChannel,
  postLog,
} = require("./embeds");

const APPROVE_PREFIX = "verify:approve:";
const DENY_PREFIX = "verify:deny:";
const RENAME_PREFIX = "verify:rename:";
const RENAME_MODAL_PREFIX = "verify:renameform:";
const RENAME_INPUT_ID = "new_name";

function isRecheckCase(reviewCase) {
  return reviewCase.reason.startsWith("recheck_");
}

function canReview(member) {
  return isStaff(member) || member.permissions.has(PermissionsBitField.Flags.ManageRoles);
}

function reviewButtons(caseId, { recheck = false, rename = false } = {}) {
  const keepButton = rename
    ? new ButtonBuilder()
        .setCustomId(`${RENAME_PREFIX}${caseId}`)
        .setLabel("Rename")
        .setStyle(ButtonStyle.Primary)
    : new ButtonBuilder()
        .setCustomId(`${APPROVE_PREFIX}${caseId}`)
        .setLabel(recheck ? "Keep verified" : "Approve")
        .setStyle(ButtonStyle.Success);
  return new ActionRowBuilder().addComponents(
    keepButton,
    new ButtonBuilder()
      .setCustomId(`${DENY_PREFIX}${caseId}`)
      .setLabel(recheck ? "Unverify" : "Deny")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildReviewEmbed(reviewCase, { accountAgeDays, lookupError, details } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.yellow)
    .setTitle(`Review #${reviewCase.id}: ${reasonText(reviewCase.reason)}`)
    .setDescription(
      `<@${reviewCase.discord_id}> submitted **${escapeMarkdown(reviewCase.char_name ?? "?")}**`
    )
    .addFields({ name: "User ID", value: reviewCase.discord_id, inline: true })
    .setTimestamp(reviewCase.created_at);

  if (accountAgeDays != null) {
    embed.addFields({ name: "Account age", value: `${accountAgeDays} days`, inline: true });
  }
  if (reviewCase.character) {
    addCharacterFields(embed, reviewCase.character);
  }
  if (lookupError) {
    embed.addFields({ name: "Lookup error", value: lookupError });
  }
  if (details?.claimedBy) {
    embed.addFields({
      name: "Already claimed by",
      value: `<@${details.claimedBy}> (${details.claimedBy})`,
    });
  }
  if (details?.claimedCharacter) {
    embed.addFields({
      name: "Previously claimed",
      value: escapeMarkdown(details.claimedCharacter),
    });
  }
  return embed;
}

async function openReviewCase(client, { discordId, charName, reason, character, context }) {
  const store = getStore();
  const reviewCase = store.createReviewCase({ discordId, charName, reason, character });
  const buttons = reviewButtons(reviewCase.id, {
    recheck: isRecheckCase(reviewCase),
    rename: offersRename(reason, store.getVerification(discordId)),
  });
  const message = await postToChannel(client, getConfig().reviewChannelId, {
    embeds: [buildReviewEmbed(reviewCase, context)],
    components: [buttons],
  });
  if (message) {
    store.setReviewMessage(reviewCase.id, message.channelId, message.id);
  }
  return reviewCase;
}

async function closeReviewMessage(interaction, { color, footer }) {
  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(color)
    .setFooter({ text: footer });
  await interaction.message.edit({ embeds: [embed], components: [] });
}

async function keepVerified(interaction, reviewCase) {
  if (!getStore().resolveReviewCase(reviewCase.id, "approved", interaction.user.id)) {
    return interaction.followUp({
      content: "Another moderator already handled this case.",
      flags: MessageFlags.Ephemeral,
    });
  }
  await closeReviewMessage(interaction, {
    color: COLORS.green,
    footer: `Kept verified by ${interaction.user.tag}`,
  });
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: COLORS.green,
      title: `Kept verified (review #${reviewCase.id})`,
      description: `<@${reviewCase.discord_id}> (**${escapeMarkdown(reviewCase.char_name ?? "?")}**), kept by <@${interaction.user.id}>`,
    })
  );
}

async function unverifyFromReview(interaction, reviewCase) {
  const store = getStore();
  if (!store.resolveReviewCase(reviewCase.id, "denied", interaction.user.id)) {
    return interaction.followUp({
      content: "Another moderator already handled this case.",
      flags: MessageFlags.Ephemeral,
    });
  }
  store.deleteVerification(reviewCase.discord_id);
  store.deleteScheduledGrant(reviewCase.discord_id);
  const member = await interaction.guild.members.fetch(reviewCase.discord_id).catch(() => null);
  const problems = member ? await revokeAccess(member) : [];

  await closeReviewMessage(interaction, {
    color: COLORS.red,
    footer: `Unverified by ${interaction.user.tag}`,
  });
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: COLORS.red,
      title: `Unverified by mod (review #${reviewCase.id})`,
      description: `<@${reviewCase.discord_id}> (**${escapeMarkdown(reviewCase.char_name ?? "?")}**), unverified by <@${interaction.user.id}>`,
      fields: problems.length ? [{ name: "Problems", value: problems.join("\n") }] : [],
    })
  );
}

async function approve(interaction, reviewCase) {
  if (isRecheckCase(reviewCase)) return keepVerified(interaction, reviewCase);
  const store = getStore();
  const modId = interaction.user.id;
  const charName = reviewCase.character?.name ?? reviewCase.char_name;

  const claim = charName ? store.getVerificationForCharacter(reviewCase.character ?? { name: charName }) : null;
  if (claim && claim.discord_id !== reviewCase.discord_id) {
    return interaction.followUp({
      content: `**${escapeMarkdown(charName)}** is already claimed by <@${claim.discord_id}>. Deny this case, or remove the other claim first.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const member = await interaction.guild.members
    .fetch(reviewCase.discord_id)
    .catch(() => null);

  if (!store.resolveReviewCase(reviewCase.id, member ? "approved" : "denied", modId)) {
    return interaction.followUp({
      content: "Another moderator already handled this case.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!member) {
    await closeReviewMessage(interaction, {
      color: COLORS.grey,
      footer: `Closed by ${interaction.user.tag}: member left the server`,
    });
    return;
  }

  store.saveVerification({
    discordId: reviewCase.discord_id,
    character: reviewCase.character ?? { name: charName },
    method: "manual",
    reviewedBy: modId,
  });
  const { problems } = await grantAccess(
    member,
    charName,
    reviewCase.character ?? undefined
  );

  await closeReviewMessage(interaction, {
    color: COLORS.green,
    footer: `Approved by ${interaction.user.tag}`,
  });
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: problems.length ? COLORS.yellow : COLORS.green,
      title: `Approved by mod (review #${reviewCase.id})`,
      description: `<@${member.id}> as **${escapeMarkdown(charName)}**, approved by <@${modId}>`,
      fields: problems.length ? [{ name: "Problems", value: problems.join("\n") }] : [],
    })
  );
  if (problems.length) {
    await interaction.followUp({
      content: `Approved, but: ${problems.join("; ")}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function deny(interaction, reviewCase) {
  if (isRecheckCase(reviewCase)) return unverifyFromReview(interaction, reviewCase);
  const modId = interaction.user.id;
  if (!getStore().resolveReviewCase(reviewCase.id, "denied", modId)) {
    return interaction.followUp({
      content: "Another moderator already handled this case.",
      flags: MessageFlags.Ephemeral,
    });
  }
  await closeReviewMessage(interaction, {
    color: COLORS.red,
    footer: `Denied by ${interaction.user.tag}`,
  });
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: COLORS.red,
      title: `Denied by mod (review #${reviewCase.id})`,
      description: `<@${reviewCase.discord_id}> (**${escapeMarkdown(reviewCase.char_name ?? "?")}**), denied by <@${modId}>`,
    })
  );
}

function buildRenameModal(reviewCase) {
  return new ModalBuilder()
    .setCustomId(`${RENAME_MODAL_PREFIX}${reviewCase.id}`)
    .setTitle("Rename member")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("New character name")
        .setDescription(`What ${reviewCase.char_name ?? "the character"} is called now`.slice(0, 100))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(RENAME_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(getConfig().maxNameLength)
            .setRequired(true)
        )
    );
}

function renameProblem(reason, name, { lookup, charClaim }) {
  const shown = `**${escapeMarkdown(name)}**`;
  const messages = {
    no_saved_id: "There's no saved character ID for this member, so I can't confirm it's the same character.",
    invalid_name: `${shown} isn't a valid character name.`,
    not_found: `${shown} wasn't found. Check the spelling.`,
    unavailable: `Couldn't look up ${shown} right now (${lookup.reason}). Try again in a bit.`,
    different_character: `${shown} is a different character, not the one this member verified with. Nothing changed.`,
    wrong_faction: `${shown} is the same character, but it's now ${lookup.character?.faction}. Use Unverify if they should lose access.`,
    wrong_server: `${shown} is the same character, but it's now on ${lookup.character?.server}. Use Unverify if they should lose access.`,
    name_already_claimed: `${shown} is already claimed by <@${charClaim?.discord_id}>.`,
  };
  return messages[reason] ?? reason;
}

async function handleRenameSubmit(interaction) {
  if (!canReview(interaction.member)) {
    return interaction.reply({
      content: "Only officers, moderators or members with Manage Roles can review verifications.",
      flags: MessageFlags.Ephemeral,
    });
  }
  const store = getStore();
  const reviewCase = store.getReviewCase(Number(interaction.customId.slice(RENAME_MODAL_PREFIX.length)));
  if (!reviewCase || reviewCase.status !== "open") {
    return interaction.reply({
      content: "Another moderator already handled this case.",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const newName = interaction.fields.getTextInputValue(RENAME_INPUT_ID).trim();
  const claim = store.getVerification(reviewCase.discord_id);
  if (!claim) {
    return interaction.editReply("This member is no longer verified, so there's nothing to rename.");
  }
  const lookup = await lookupCharacter(newName, { fresh: true });
  const charClaim = lookup.status === "found" ? store.getVerificationByCharName(lookup.character.name) : null;
  const decision = decideRename({ claim, lookup, charClaim, config: getConfig() });
  if (!decision.ok) {
    return interaction.editReply(renameProblem(decision.reason, newName, { lookup, charClaim }));
  }

  const character = lookup.character;
  if (!store.resolveReviewCase(reviewCase.id, "approved", interaction.user.id)) {
    return interaction.editReply("Another moderator already handled this case.");
  }
  store.updateClaimDetails(reviewCase.discord_id, character);
  const member = await interaction.guild.members.fetch(reviewCase.discord_id).catch(() => null);
  const problems = [];
  if (member) {
    problems.push(...(await applyCharacterRoles(member, character)));
    if (canRename(member)) problems.push(...(await applyNickname(member, character.name, character)));
  } else {
    problems.push("member is no longer in the server");
  }

  const oldName = escapeMarkdown(claim.char_name);
  const shownName = escapeMarkdown(character.name);
  await closeReviewMessage(interaction, {
    color: COLORS.green,
    footer: `Renamed to ${character.name} by ${interaction.user.tag}`,
  });
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: problems.length ? COLORS.yellow : COLORS.green,
      title: `Renamed by mod (review #${reviewCase.id})`,
      description: `<@${reviewCase.discord_id}> **${oldName}** → **${shownName}**, renamed by <@${interaction.user.id}>`,
      fields: problems.length ? [{ name: "Problems", value: problems.join("\n") }] : [],
    })
  );
  return interaction.editReply(
    `Renamed **${oldName}** to **${shownName}**.` + (problems.length ? ` But: ${problems.join("; ")}` : "")
  );
}

function isReviewButton(customId) {
  return [APPROVE_PREFIX, DENY_PREFIX, RENAME_PREFIX].some((prefix) => customId.startsWith(prefix));
}

function isRenameModal(customId) {
  return customId.startsWith(RENAME_MODAL_PREFIX);
}

async function handleReviewButton(interaction) {
  if (!canReview(interaction.member)) {
    return interaction.reply({
      content: "Only officers, moderators or members with Manage Roles can review verifications.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const isApprove = interaction.customId.startsWith(APPROVE_PREFIX);
  const caseId = Number(interaction.customId.split(":")[2]);
  const reviewCase = getStore().getReviewCase(caseId);
  if (!reviewCase) {
    return interaction.reply({
      content: "This review case no longer exists.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (reviewCase.status !== "open") {
    return interaction.reply({
      content: `This case was already ${reviewCase.status} by <@${reviewCase.resolved_by}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.customId.startsWith(RENAME_PREFIX)) {
    return interaction.showModal(buildRenameModal(reviewCase));
  }
  await interaction.deferUpdate();
  return isApprove ? approve(interaction, reviewCase) : deny(interaction, reviewCase);
}

async function closeReviewCaseAsApproved(interaction, reviewCase) {
  if (!getStore().resolveReviewCase(reviewCase.id, "approved", interaction.user.id)) return null;
  if (!reviewCase.channel_id || !reviewCase.message_id) return [];
  try {
    const channel = await interaction.client.channels.fetch(reviewCase.channel_id);
    const message = await channel.messages.fetch(reviewCase.message_id);
    const embed = EmbedBuilder.from(message.embeds[0])
      .setColor(COLORS.green)
      .setFooter({ text: `Approved by ${interaction.user.tag} with /verify-manual` });
    await message.edit({ embeds: [embed], components: [] });
    return [];
  } catch (error) {
    return [`review message: ${error.message}`];
  }
}

module.exports = {
  openReviewCase,
  isReviewButton,
  handleReviewButton,
  isRenameModal,
  handleRenameSubmit,
  closeReviewCaseAsApproved,
};
