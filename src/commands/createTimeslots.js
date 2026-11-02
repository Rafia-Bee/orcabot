const { SlashCommandBuilder, PermissionsBitField, MessageFlags, escapeMarkdown } = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { parseRaidHelperId, fetchEvent } = require("../roster/comp");
const { planSlots } = require("../timeslots/schedule");
const { PREFIX, renderBoard, startTimeslotSweeper, handleComponent } = require("../timeslots/board");

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

    await interaction.guild.members.fetch();
    const role = interaction.guild.roles.cache.get(cfg.forceLeaderRoleId);
    const leaderCount = role ? role.members.filter((member) => !member.user.bot).size : 0;
    if (leaderCount === 0) return interaction.editReply("Nobody has the Force Leader role.");

    let plan;
    try {
      plan = planSlots({
        eventStart,
        ...cfg.timeslots,
        timeZone: cfg.timeZone,
        leaderCount,
      });
    } catch (error) {
      return interaction.editReply(error.message);
    }
    if (plan.slots.length === 0) {
      return interaction.editReply(
        `No ${cfg.timeslots.durationMinutes} min timeslot fits between ${cfg.timeslots.first} and ` +
          `${cfg.timeslots.last} (${cfg.timeZone}) on the event day anymore.`
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
      slots: plan.slots,
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

    const first = plan.slots[0];
    const last = plan.slots[plan.slots.length - 1];
    const notes = [
      `Posted ${plan.slots.length} timeslots of ${cfg.timeslots.durationMinutes} min ` +
        `(${ts(first.startsAt)}–${ts(last.endsAt)}) for **${escapeMarkdown(title)}** on ${ts(eventStart, "F")}.`,
    ];
    if (leaderCount > plan.slots.length) {
      notes.push(
        `There are ${leaderCount} force leaders, but only ${plan.slots.length} timeslots fit, so ` +
          `${leaderCount - plan.slots.length} of them can't pick one. Shorten TIMESLOT_DURATION or move ` +
          "FIRST_TIMESLOT / LAST_TIMESLOT with /verify-config, then run this again with replace:True."
      );
    }
    if (plan.startedLate) notes.push(`FIRST_TIMESLOT (${cfg.timeslots.first}) had already passed, so the first timeslot starts at ${ts(first.startsAt)}.`);
    if (last.endsAt > eventStart) notes.push("Warning: the last timeslot ends after the event starts. Check LAST_TIMESLOT.");
    return interaction.editReply(notes.join("\n"));
  },
};
