const { SlashCommandBuilder, PermissionsBitField, MessageFlags, escapeMarkdown } = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { parseRaidHelperId, fetchEvent } = require("../roster/comp");
const { PREFIX, renderBoard, startTimeslotSweeper, handleComponent } = require("../timeslots/board");

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const ts = (ms, style = "t") => `<t:${Math.floor(ms / 1000)}:${style}>`;

async function closeOldBoard(interaction, board) {
  const store = getStore();
  store.closeTimeslotBoard(board.id);
  try {
    const channel = await interaction.client.channels.fetch(board.channel_id);
    const message = await channel.messages.fetch(board.message_id);
    await message.edit({
      ...renderBoard({ ...board, status: "closed" }, store.getTimeslots(board.id)),
      content: "Replaced by a new timeslot board.",
      allowedMentions: { parse: [] },
    });
  } catch {}
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("create-timeslots")
    .setDescription("Post comp editing timeslots for a raid-helper event that force leaders can pick from")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addStringOption((option) =>
      option.setName("event").setDescription("The raid-helper event ID or link").setRequired(true).setMaxLength(200)
    )
    .addBooleanOption((option) =>
      option.setName("replace").setDescription("Replace this event's existing timeslots (everyone's picks are lost)")
    ),
  customIdPrefix: PREFIX,
  handleComponent,
  onReady: startTimeslotSweeper,
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({
        content: "You need the Manage Channels permission to do this.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const cfg = getConfig();
    if (!cfg.forceLeaderRoleId) {
      return interaction.reply({ content: "Set FORCE_LEADER_ROLE_ID in .env first.", flags: MessageFlags.Ephemeral });
    }
    const eventId = parseRaidHelperId(interaction.options.getString("event"));
    if (!eventId) {
      return interaction.reply({
        content: "That doesn't look like a raid-helper event ID or link.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const store = getStore();
    const existing = store.getOpenTimeslotBoardForEvent(eventId);
    if (existing && !interaction.options.getBoolean("replace")) {
      const link = existing.message_id
        ? ` https://discord.com/channels/${existing.guild_id}/${existing.channel_id}/${existing.message_id}`
        : "";
      return interaction.editReply(
        `This event already has timeslots:${link}\nRun the command again with replace:True to start over.`
      );
    }

    let event;
    try {
      event = await fetchEvent(eventId, { apiKey: cfg.roster.raidHelperApiKey, userAgent: cfg.lookup.userAgent });
    } catch (error) {
      return interaction.editReply(`Couldn't load event ${eventId}: ${error.message}`);
    }
    const eventStart = Number(event.startTime) * 1000;
    if (!eventStart) return interaction.editReply("raid-helper didn't send a start time for this event.");
    if (eventStart <= Date.now()) return interaction.editReply("This event has already started.");

    const { durationMinutes, minHoursBeforeEvent } = cfg.timeslots;
    const latestEnd = eventStart - minHoursBeforeEvent * HOUR_MS;
    if (latestEnd - durationMinutes * MIN_MS < Date.now()) {
      return interaction.editReply(
        `It's too late for timeslots. They must end at least ${minHoursBeforeEvent} hours before the event.`
      );
    }

    const title = String(event.displayTitle || event.title || "Event");
    if (existing) await closeOldBoard(interaction, existing);
    const board = store.createTimeslotBoard({
      raidEventId: eventId,
      title,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      eventStart,
      createdBy: interaction.user.id,
    });
    try {
      const message = await interaction.channel.send({
        ...renderBoard(board, store.getTimeslots(board.id)),
        allowedMentions: { parse: [] },
      });
      store.setTimeslotBoardMessage(board.id, message.id);
    } catch (error) {
      store.closeTimeslotBoard(board.id);
      return interaction.editReply(`Couldn't post the timeslots in this channel: ${error.message}`);
    }

    return interaction.editReply(
      `Posted the timeslot board for **${escapeMarkdown(title)}** on ${ts(eventStart, "F")}. ` +
        `Force leaders can book ${durationMinutes} min timeslots that end by ${ts(latestEnd, "f")}.`
    );
  },
};
