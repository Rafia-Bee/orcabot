const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { grantAccess } = require("./access");
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

function reviewButtons(caseId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPROVE_PREFIX}${caseId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${DENY_PREFIX}${caseId}`)
      .setLabel("Deny")
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
  const message = await postToChannel(client, getConfig().reviewChannelId, {
    embeds: [buildReviewEmbed(reviewCase, context)],
    components: [reviewButtons(reviewCase.id)],
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

async function approve(interaction, reviewCase) {
  const store = getStore();
  const modId = interaction.user.id;
  const charName = reviewCase.character?.name ?? reviewCase.char_name;

  const claim = charName ? store.getVerificationByCharName(charName) : null;
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
    reviewCase.character ? reviewCase.character.legion ?? null : undefined
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

function isReviewButton(customId) {
  return customId.startsWith(APPROVE_PREFIX) || customId.startsWith(DENY_PREFIX);
}

async function handleReviewButton(interaction) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({
      content: "You need the Manage Roles permission to review verifications.",
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
  closeReviewCaseAsApproved,
};
