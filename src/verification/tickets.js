const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SnowflakeUtil,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { grantAccess } = require("./access");
const { COLORS, buildEventEmbed, postLog } = require("./embeds");
const { DAY_MS } = require("./rules");

const PREFIX = "verify:ticket:";
const DENY_MODAL_PREFIX = "verify:ticket-deny:";
const DENY_REASON_INPUT_ID = "reason";
const ARCHIVE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const SLOT_LABELS = {
  MainHand: "your main-hand weapon",
  SubHand: "your off-hand item",
  Helmet: "your helmet",
  Shoulder: "your shoulder armor",
  Torso: "your chest armor",
  Pants: "your leg armor",
  Gloves: "your gloves",
  Boots: "your boots",
  Cape: "your cape",
  Belt: "your belt",
  Necklace: "your necklace",
  Amulet: "your amulet",
  Earring1: "one of your earrings",
  Earring2: "one of your earrings",
  Ring1: "one of your rings",
  Ring2: "one of your rings",
  Bracelet1: "one of your bracelets",
  Bracelet2: "one of your bracelets",
  Rune1: "one of your runes",
  Rune2: "one of your runes",
};

function slotLabel(slot) {
  return SLOT_LABELS[slot] ?? (/^Arcana\d$/.test(slot) ? "one of your arcana" : `your ${slot}`);
}

function pickSlot(character) {
  const pool = getConfig().ticketGearSlots;
  const equipped = pool.filter((slot) => character.equipment?.[slot]);
  const choices = equipped.length > 0 ? equipped : pool;
  return choices[Math.floor(Math.random() * choices.length)];
}

function channelName(ticketId, charName) {
  const slug = charName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `verify-${ticketId}-${slug}` : `verify-${ticketId}`;
}

function ticketButtons(ticketId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}verify:${ticketId}`)
      .setLabel("Verify")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}deny:${ticketId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}ban:${ticketId}`)
      .setLabel("Ban")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

function buildTicketMessage(ticket) {
  const c = ticket.character;
  const name = escapeMarkdown(c.name);
  const embed = new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle("Character verification")
    .setDescription(
      [
        `To confirm **${name}** is your character, please post an **in-game screenshot** ` +
          `of your character's equipment with **${slotLabel(ticket.slot)}** unequipped.`,
        "",
        "An officer will review it shortly.",
      ].join("\n")
    )
    .addFields(
      { name: "Character", value: name, inline: true },
      { name: "Class", value: c.className ?? "?", inline: true },
      { name: "Level", value: String(c.level ?? "?"), inline: true },
      { name: "Gear score", value: String(c.gearScore ?? "?"), inline: true }
    );
  return {
    content: `<@${ticket.discord_id}>`,
    embeds: [embed],
    components: [ticketButtons(ticket.id)],
    allowedMentions: { users: [ticket.discord_id] },
  };
}

async function openTicket(interaction, { character, reason }) {
  const cfg = getConfig();
  const store = getStore();
  const guild = interaction.guild;
  const ticket = store.createTicket({
    discordId: interaction.user.id,
    guildId: guild.id,
    character,
    reason,
    slot: pickSlot(character),
  });

  const participant = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  let channel = null;
  try {
    channel = await guild.channels.create({
      name: channelName(ticket.id, character.name),
      type: ChannelType.GuildText,
      parent: cfg.ticketsCategoryId,
      reason: `Verification ticket #${ticket.id}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: participant },
        { id: cfg.officersRoleId, allow: participant },
        ...(cfg.moderatorRoleId ? [{ id: cfg.moderatorRoleId, allow: participant }] : []),
        {
          id: interaction.client.user.id,
          allow: [...participant, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels],
        },
      ],
    });
    const message = await channel.send(buildTicketMessage(ticket));
    store.setTicketChannel(ticket.id, channel.id, message.id);
    return { ...ticket, channel_id: channel.id, message_id: message.id };
  } catch (error) {
    store.deleteTicket(ticket.id);
    if (channel) await channel.delete().catch(() => {});
    throw error;
  }
}

function isStaff(member) {
  const cfg = getConfig();
  return (
    member.roles.cache.has(cfg.officersRoleId) ||
    (cfg.moderatorRoleId !== null && member.roles.cache.has(cfg.moderatorRoleId)) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

async function askConfirmation(interaction, ticket, action) {
  const name = escapeMarkdown(ticket.char_name);
  const isBan = action === "ban";
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}confirm-${action}:${ticket.id}`)
      .setLabel(isBan ? "Yes, ban" : "Yes, verify")
      .setStyle(isBan ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}cancel:${ticket.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
  return interaction.reply({
    content: isBan
      ? `Ban <@${ticket.discord_id}> (**${name}**) from the server?`
      : `Verify <@${ticket.discord_id}>? They'll get the Verified role and the nickname **${name}**.`,
    components: [row],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function archiveTicket(interaction, ticket, { color, title, memberCanRead = false }) {
  const cfg = getConfig();
  const problems = [];
  const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return ["ticket channel no longer exists"];

  await channel.messages
    .fetch(ticket.message_id)
    .then((message) => message.edit({ components: [ticketButtons(ticket.id, true)] }))
    .catch((error) => problems.push(`buttons: ${error.message}`));
  await channel
    .send({
      embeds: [new EmbedBuilder().setColor(color).setTitle(title).setTimestamp()],
      allowedMentions: { parse: [] },
    })
    .catch((error) => problems.push(`message: ${error.message}`));
  const memberAccess = memberCanRead
    ? channel.permissionOverwrites.edit(
        ticket.discord_id,
        { ViewChannel: true, ReadMessageHistory: true, SendMessages: false, AttachFiles: false },
        { reason: "Ticket closed" }
      )
    : channel.permissionOverwrites.delete(ticket.discord_id, "Ticket closed");
  await memberAccess.catch((error) => problems.push(`member access: ${error.message}`));
  await channel
    .setParent(cfg.archivedTicketsCategoryId, { lockPermissions: false, reason: "Ticket closed" })
    .catch((error) => problems.push(`archive: ${error.message}`));
  return problems;
}

async function closeTicketAsVerified(interaction, ticket) {
  if (!getStore().resolveTicket(ticket.id, "verified", interaction.user.id)) return null;
  return archiveTicket(interaction, ticket, {
    color: COLORS.green,
    title: `Verified by ${interaction.user.tag}`,
  });
}

async function logTicketResult(interaction, ticket, { color, title, problems, reason }) {
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: problems.length ? COLORS.yellow : color,
      title: `${title} (ticket #${ticket.id})`,
      description: `<@${ticket.discord_id}> (**${escapeMarkdown(ticket.char_name)}**) by <@${interaction.user.id}> in <#${ticket.channel_id}>`,
      fields: [
        ...(reason ? [{ name: "Reason", value: reason }] : []),
        ...(problems.length ? [{ name: "Problems", value: problems.join("\n") }] : []),
      ],
    })
  );
}

function defaultDenyReason(ticket) {
  const cfg = getConfig();
  const c = ticket.character ?? {};
  const reasons = [];
  if (c.level != null && c.level < cfg.minLevel) {
    reasons.push(`your level is below the minimum (${cfg.minLevel})`);
  }
  if (c.gearScore == null || c.gearScore < cfg.minGearScore) {
    reasons.push(`your gear score is below the minimum (${cfg.minGearScore})`);
  }
  if (reasons.length === 0 || ticket.reason === "account_too_new") {
    reasons.push(`your Discord account is newer than ${cfg.minAccountAgeDays} days`);
  }
  return reasons.join(" and ");
}

function buildDenyModal(ticket) {
  return new ModalBuilder()
    .setCustomId(`${DENY_MODAL_PREFIX}${ticket.id}`)
    .setTitle(`Deny ${ticket.char_name}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(DENY_REASON_INPUT_ID)
          .setLabel("We cannot verify for now because...")
          .setValue(defaultDenyReason(ticket))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
      )
    );
}

async function handleDenySubmit(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: "Only officers and moderators can do this.", flags: MessageFlags.Ephemeral });
  }
  const store = getStore();
  const ticket = store.getTicket(Number(interaction.customId.slice(DENY_MODAL_PREFIX.length)));
  if (!ticket) {
    return interaction.reply({ content: "This ticket no longer exists.", flags: MessageFlags.Ephemeral });
  }
  if (!store.resolveTicket(ticket.id, "denied", interaction.user.id)) {
    return interaction.reply({ content: "Another officer already handled this ticket.", flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = interaction.fields
    .getTextInputValue(DENY_REASON_INPUT_ID)
    .trim()
    .replace(/[.!\s]+$/, "");
  const problems = [];
  const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (channel) {
    await channel
      .send({
        content: `<@${ticket.discord_id}> We cannot verify for now because ${reason}. If this is your alt, please apply with your main.`,
        allowedMentions: { users: [ticket.discord_id] },
      })
      .catch((error) => problems.push(`denial message: ${error.message}`));
  }

  const result = { color: COLORS.grey, title: `Denied by ${interaction.user.tag}`, memberCanRead: true };
  problems.push(...(await archiveTicket(interaction, ticket, result)));
  await logTicketResult(interaction, ticket, { ...result, title: "Denied", problems, reason });
  return interaction.editReply(
    problems.length
      ? `Denied, but: ${problems.join("; ")}`
      : "Denied. The member was told why and the ticket has been archived."
  );
}

async function confirmBan(interaction, ticket) {
  const store = getStore();
  if (!store.resolveTicket(ticket.id, "banned", interaction.user.id)) {
    return interaction.update({ content: "Another officer already handled this ticket.", components: [] });
  }
  await interaction.update({ content: "Banning…", components: [] });

  try {
    await interaction.guild.members.ban(ticket.discord_id, {
      reason: `Verification ticket #${ticket.id}, banned by ${interaction.user.tag}`,
    });
  } catch (error) {
    store.reopenTicket(ticket.id);
    return interaction.editReply(`Couldn't ban: ${error.message}`);
  }

  const result = { color: COLORS.red, title: `Banned by ${interaction.user.tag}` };
  const problems = await archiveTicket(interaction, ticket, result);
  await logTicketResult(interaction, ticket, { ...result, title: "Banned", problems });
  return interaction.editReply(
    problems.length ? `Banned, but: ${problems.join("; ")}` : "Banned. The ticket has been archived."
  );
}

async function confirmVerify(interaction, ticket) {
  const store = getStore();
  const member = await interaction.guild.members.fetch(ticket.discord_id).catch(() => null);
  if (!member) {
    return interaction.update({
      content: "That member is no longer in the server, so they can't be verified. You can still ban them.",
      components: [],
    });
  }
  const claim = store.getVerificationByCharName(ticket.char_name);
  if (claim && claim.discord_id !== ticket.discord_id) {
    return interaction.update({
      content: `**${escapeMarkdown(ticket.char_name)}** is already claimed by <@${claim.discord_id}>. Remove that claim first, or ban this member.`,
      components: [],
      allowedMentions: { parse: [] },
    });
  }
  if (!store.resolveTicket(ticket.id, "verified", interaction.user.id)) {
    return interaction.update({ content: "Another officer already handled this ticket.", components: [] });
  }
  await interaction.update({ content: "Verifying…", components: [] });

  store.saveVerification({
    discordId: member.id,
    character: ticket.character,
    method: "ticket",
    reviewedBy: interaction.user.id,
  });
  const { roleGranted, problems } = await grantAccess(member, ticket.char_name, ticket.character ?? {});
  if (!roleGranted) {
    store.deleteVerification(member.id);
    store.reopenTicket(ticket.id);
    return interaction.editReply(`Couldn't give the Verified role: ${problems.join("; ")}`);
  }

  const result = { color: COLORS.green, title: `Verified by ${interaction.user.tag}` };
  problems.push(...(await archiveTicket(interaction, ticket, result)));
  await logTicketResult(interaction, ticket, { ...result, title: "Verified", problems });
  return interaction.editReply(
    problems.length ? `Verified, but: ${problems.join("; ")}` : "Verified. The ticket has been archived."
  );
}

function isTicketButton(customId) {
  return customId.startsWith(PREFIX);
}

function isTicketDenyModal(customId) {
  return customId.startsWith(DENY_MODAL_PREFIX);
}

async function handleTicketButton(interaction) {
  const [action, rawId] = interaction.customId.slice(PREFIX.length).split(":");
  const fromConfirmation = action.startsWith("confirm-") || action === "cancel";
  const respond = (content) =>
    fromConfirmation
      ? interaction.update({ content, components: [] })
      : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (!isStaff(interaction.member)) {
    return respond("Only officers and moderators can do this.");
  }
  if (action === "cancel") {
    return respond("Cancelled.");
  }

  const ticket = getStore().getTicket(Number(rawId));
  if (!ticket) {
    return respond("This ticket no longer exists.");
  }
  if (ticket.status !== "open") {
    return respond(`This ticket was already ${ticket.status} by <@${ticket.resolved_by}>.`);
  }

  if (action === "deny") return interaction.showModal(buildDenyModal(ticket));
  if (action === "ban" || action === "verify") return askConfirmation(interaction, ticket, action);
  if (action === "confirm-ban") return confirmBan(interaction, ticket);
  if (action === "confirm-verify") return confirmVerify(interaction, ticket);
}

async function deleteExpiredArchivedTickets(client) {
  const cfg = getConfig();
  const category = await client.channels.fetch(cfg.archivedTicketsCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return;

  const cutoff = Date.now() - cfg.archivedTicketRetentionDays * DAY_MS;
  const deleted = [];
  const failed = [];
  for (const channel of category.children.cache.values()) {
    if (channel.type !== ChannelType.GuildText || !channel.name.startsWith("verify-")) continue;
    const lastActivity = channel.lastMessageId
      ? SnowflakeUtil.timestampFrom(channel.lastMessageId)
      : channel.createdTimestamp;
    if (lastActivity > cutoff) continue;
    try {
      await channel.delete(`Archived ticket inactive for ${cfg.archivedTicketRetentionDays} days`);
      deleted.push(channel.name);
    } catch (error) {
      failed.push(`${channel.name}: ${error.message}`);
    }
  }

  if (deleted.length === 0 && failed.length === 0) return;
  const fields = [];
  if (deleted.length) fields.push({ name: "Deleted", value: deleted.join("\n").slice(0, 1024) });
  if (failed.length) fields.push({ name: "Failed", value: failed.join("\n").slice(0, 1024) });
  await postLog(
    client,
    buildEventEmbed({
      color: failed.length ? COLORS.yellow : COLORS.grey,
      title: "Archived tickets cleaned up",
      description: `Deleted ${deleted.length} archived ticket channel(s) with no messages for ${cfg.archivedTicketRetentionDays}+ days.`,
      fields,
    })
  );
}

function startArchiveCleanup(client) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await deleteExpiredArchivedTickets(client);
    } catch (error) {
      console.error("Archive cleanup error:", error);
    } finally {
      running = false;
    }
  };
  run();
  return setInterval(run, ARCHIVE_CLEANUP_INTERVAL_MS);
}

module.exports = {
  openTicket,
  isTicketButton,
  handleTicketButton,
  isTicketDenyModal,
  handleDenySubmit,
  slotLabel,
  startArchiveCleanup,
  closeTicketAsVerified,
  isStaff,
};
