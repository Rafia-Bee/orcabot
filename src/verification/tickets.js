const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { grantAccess } = require("./access");
const { COLORS, buildEventEmbed, postLog } = require("./embeds");

const PREFIX = "verify:ticket:";

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

function isOfficer(member) {
  return (
    member.roles.cache.has(getConfig().officersRoleId) ||
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

async function archiveTicket(interaction, ticket, { color, title }) {
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
  await channel.permissionOverwrites
    .delete(ticket.discord_id, "Ticket closed")
    .catch((error) => problems.push(`member access: ${error.message}`));
  await channel
    .setParent(cfg.archivedTicketsCategoryId, { lockPermissions: false, reason: "Ticket closed" })
    .catch((error) => problems.push(`archive: ${error.message}`));
  return problems;
}

async function logTicketResult(interaction, ticket, { color, title, problems }) {
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: problems.length ? COLORS.yellow : color,
      title: `${title} (ticket #${ticket.id})`,
      description: `<@${ticket.discord_id}> (**${escapeMarkdown(ticket.char_name)}**) by <@${interaction.user.id}> in <#${ticket.channel_id}>`,
      fields: problems.length ? [{ name: "Problems", value: problems.join("\n") }] : [],
    })
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
  const { roleGranted, problems } = await grantAccess(member, ticket.char_name);
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

async function handleTicketButton(interaction) {
  const [action, rawId] = interaction.customId.slice(PREFIX.length).split(":");
  const fromConfirmation = action.startsWith("confirm-") || action === "cancel";
  const respond = (content) =>
    fromConfirmation
      ? interaction.update({ content, components: [] })
      : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (!isOfficer(interaction.member)) {
    return respond("Only officers can do this.");
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

  if (action === "ban" || action === "verify") return askConfirmation(interaction, ticket, action);
  if (action === "confirm-ban") return confirmBan(interaction, ticket);
  if (action === "confirm-verify") return confirmVerify(interaction, ticket);
}

module.exports = { openTicket, isTicketButton, handleTicketButton, slotLabel };
