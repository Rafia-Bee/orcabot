// The timeslot board: the message force leaders use to book their turn editing the comp, and the pings when it's their turn.
// renderBoard: builds the board message, upcoming timeslots first in time order, then past ones.
// startTimeslotSweeper: checks open boards every 15 seconds to ping whoever's turn it is and close finished boards.
// handleComponent: handles the board's buttons, the timezone list and the pick form.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { COLORS } = require("../verification/embeds");
const { zonedParts, zonedDateTime, clock } = require("../time");
const { parseClock, dateChoices, checkPick, isActive, splitSlots, dueSlots, nextEarlySlot } = require("./schedule");
const { zoneOptions } = require("./zones");

const PREFIX = "timeslot";
const SWEEP_INTERVAL_MS = 15_000;
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const EARLY_START_WINDOW_MS = 2 * HOUR_MS;
const UNKNOWN_MESSAGE = 10008;
const DATE_INPUT_ID = "date";
const TIME_INPUT_ID = "time";

const ts = (ms, style = "t") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const range = (slot) => `${ts(slot.starts_at, "f")}–${ts(slot.ends_at)}`;
const dateKey = ({ year, month, day }) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const dateLabel = ({ year, month, day }) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(Date.UTC(year, month - 1, day))
  );

function slotLine(slot, now, next) {
  const state =
    slot.done_at !== null
      ? " · Done"
      : isActive(slot, now)
        ? " · Now editing"
        : next
          ? ` · Next, ${ts(slot.starts_at, "R")}`
          : "";
  return `${range(slot)} · <@${slot.user_id}>${state}`;
}

function renderBoard(board, slots, now = Date.now()) {
  const finished = board.status !== "open" || now >= board.event_start;
  const { upcoming, past } = splitSlots(slots, now);
  const lines = [
    `Event starts ${ts(board.event_start, "F")}.`,
    finished
      ? "These timeslots are closed."
      : "Force leaders: press **Pick a time** to book your turn editing the comp. You'll be pinged here when it starts. " +
        "Press **I'm done** when you've finished, so the next force leader can start early.",
    "",
    "**Upcoming**",
    ...(upcoming.length
      ? upcoming.map((slot, i) => slotLine(slot, now, i === 0))
      : [finished ? "None." : "Nobody has picked a time yet."]),
  ];
  if (past.length) lines.push("", "**Past timeslots**", ...past.map((slot) => slotLine(slot, now, false)));

  const embed = new EmbedBuilder()
    .setColor(finished ? COLORS.grey : COLORS.blue)
    .setTitle(`Comp editing timeslots: ${board.title}`.slice(0, 256))
    .setDescription(lines.join("\n").slice(0, 4096));
  if (finished) return { embeds: [embed], components: [] };

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:pick:${board.id}`).setLabel("Pick a time").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:release:${board.id}`)
      .setLabel("Give up my timeslot")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:zone:${board.id}`)
      .setLabel("Change my timezone")
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [buttons] };
}

async function editBoardMessage(client, board) {
  if (!board.message_id) return;
  const channel = await client.channels.fetch(board.channel_id);
  const message = await channel.messages.fetch(board.message_id);
  await message.edit({ ...renderBoard(board, getStore().getTimeslots(board.id)), allowedMentions: { parse: [] } });
}

function reminderText(board, slot, early) {
  const title = `**${escapeMarkdown(board.title)}**`;
  return early
    ? `<@${slot.user_id}> the comp for ${title} is free, so you can start editing early. ` +
        `Your timeslot is ${range(slot)}. Press **I'm done** when you've finished.`
    : `<@${slot.user_id}> your timeslot for editing the comp for ${title} has started (${range(slot)}). ` +
        `Press **I'm done** when you've finished, so the next force leader can start.`;
}

function doneButton(board, slot) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:done:${board.id}:${slot.slot_index}`)
      .setLabel("I'm done")
      .setStyle(ButtonStyle.Success)
  );
}

async function sendReminder(channel, board, slot, early) {
  const message = await channel.send({
    content: reminderText(board, slot, early),
    components: [doneButton(board, slot)],
    allowedMentions: { users: [slot.user_id] },
  });
  getStore().markTimeslotReminded(board.id, slot.slot_index, message.id);
}

const lastSweepAt = new Map();

async function processBoard(client, board) {
  const store = getStore();
  const now = Date.now();
  const since = lastSweepAt.get(board.id) ?? 0;
  lastSweepAt.set(board.id, now);

  if (now >= board.event_start) {
    store.closeTimeslotBoard(board.id);
    await editBoardMessage(client, { ...board, status: "closed" });
    return;
  }

  const slots = store.getTimeslots(board.id);
  let changed = slots.some((slot) => slot.ends_at > since && slot.ends_at <= now);
  const due = dueSlots(slots, now);
  if (due.length) {
    const channel = await client.channels.fetch(board.channel_id);
    for (const slot of due) await sendReminder(channel, board, slot, false);
    changed = true;
  }
  if (changed) await editBoardMessage(client, board);
}

async function processBoardSafely(client, board) {
  try {
    await processBoard(client, board);
  } catch (error) {
    if (error.code === UNKNOWN_MESSAGE) {
      getStore().closeTimeslotBoard(board.id);
      console.log(`Timeslot board ${board.id} closed: its message was deleted`);
      return;
    }
    console.error(`Timeslot board ${board.id} error:`, error);
  }
}

function startTimeslotSweeper(client) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      for (const board of getStore().getOpenTimeslotBoards()) {
        await processBoardSafely(client, board);
      }
    } finally {
      running = false;
    }
  };
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS);
}

function ephemeral(interaction, content) {
  const reply = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  return interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply);
}

function isForceLeader(interaction) {
  const { forceLeaderRoleId } = getConfig();
  return Boolean(forceLeaderRoleId && interaction.member.roles.cache.has(forceLeaderRoleId));
}

function pickLimits(board) {
  const { durationMinutes, minHoursBeforeEvent } = getConfig().timeslots;
  const durationMs = durationMinutes * MIN_MS;
  const minGapMs = minHoursBeforeEvent * HOUR_MS;
  const latestEnd = board.event_start - minGapMs;
  return { durationMinutes, minHoursBeforeEvent, durationMs, minGapMs, latestEnd, latestStart: latestEnd - durationMs };
}

function tooLateText(limits) {
  return `It's too late to pick a timeslot. Timeslots must end at least ${limits.minHoursBeforeEvent} hours before the event.`;
}

function zoneMenu(board, then, current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:setzone:${board.id}:${then}`)
      .setPlaceholder("Pick your timezone")
      .addOptions(zoneOptions().map((option) => ({ ...option, default: option.value === current })))
  );
}

function pickModal(board, timeZone, mine, now = Date.now()) {
  const limits = pickLimits(board);
  const dates = dateChoices({ now, latestStart: limits.latestStart, timeZone });
  if (!dates.length) return null;

  const mineDate = mine ? dateKey(zonedParts(mine.starts_at, timeZone)) : null;
  const eventDate = dateKey(zonedParts(board.event_start, timeZone));
  const options = dates.map((date, i) => {
    const value = dateKey(date);
    const option = { label: dateLabel(date), value, default: value === mineDate };
    if (i === 0) option.description = "Today";
    else if (value === eventDate) option.description = "Event day";
    return option;
  });

  const timeInput = new TextInputBuilder()
    .setCustomId(TIME_INPUT_ID)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("18:30")
    .setMinLength(3)
    .setMaxLength(5)
    .setRequired(true);
  if (mine) timeInput.setValue(clock(mine.starts_at, timeZone));

  const deadline = `${clock(limits.latestEnd, timeZone)} on ${dateLabel(zonedParts(limits.latestEnd, timeZone))}`;
  return new ModalBuilder()
    .setCustomId(`${PREFIX}:submit:${board.id}`)
    .setTitle("Pick your timeslot")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Date")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId(DATE_INPUT_ID).setPlaceholder("Pick a date").addOptions(options)
        ),
      new LabelBuilder()
        .setLabel("Start time (24-hour, your time)")
        .setDescription(
          `${timeZone} time. Timeslots are ${limits.durationMinutes} min and must end by ${deadline}.`.slice(0, 100)
        )
        .setTextInputComponent(timeInput)
    );
}

function myTimeslot(board, userId) {
  return getStore()
    .getTimeslots(board.id)
    .find((slot) => slot.user_id === userId);
}

async function handlePick(interaction, board) {
  if (!isForceLeader(interaction)) return ephemeral(interaction, "Only force leaders can pick a timeslot.");
  const mine = myTimeslot(board, interaction.user.id);
  if (mine?.reminded_at) {
    return ephemeral(interaction, "Your turn has already started, so you can't change your timeslot.");
  }
  const timeZone = getStore().getUserTimeZone(interaction.user.id);
  if (!timeZone) {
    return interaction.reply({
      content:
        "First, which timezone are you in? Pick the one that shows the time on your clock right now. " +
        "You only need to do this once.",
      components: [zoneMenu(board, "pick", null)],
      flags: MessageFlags.Ephemeral,
    });
  }
  const modal = pickModal(board, timeZone, mine);
  if (!modal) return ephemeral(interaction, tooLateText(pickLimits(board)));
  return interaction.showModal(modal);
}

async function handleZoneButton(interaction, board) {
  return interaction.reply({
    content: "Pick the timezone that shows the time on your clock right now.",
    components: [zoneMenu(board, "save", getStore().getUserTimeZone(interaction.user.id))],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetZone(interaction, board, then) {
  const timeZone = interaction.values[0];
  if (!zoneOptions().some((option) => option.value === timeZone)) return;
  getStore().setUserTimeZone(interaction.user.id, timeZone);
  const saved = `Saved. Your timezone is ${timeZone}, where it's ${clock(Date.now(), timeZone)} now.`;
  if (then !== "pick") return interaction.update({ content: saved, components: [] });

  const mine = myTimeslot(board, interaction.user.id);
  if (mine?.reminded_at) {
    return interaction.update({
      content: `${saved} Your turn has already started, so you can't change your timeslot.`,
      components: [],
    });
  }
  const modal = pickModal(board, timeZone, mine);
  if (!modal) return interaction.update({ content: `${saved} ${tooLateText(pickLimits(board))}`, components: [] });
  return interaction.showModal(modal);
}

function problemText(result, limits, timeZone, now) {
  if (result.problem === "past") {
    return `That time has already passed. It's ${clock(now, timeZone)} for you now (${timeZone}).`;
  }
  if (result.problem === "too_late") {
    return (
      `Timeslots must end at least ${limits.minHoursBeforeEvent} hours before the event, ` +
      `so the latest you can start is ${ts(limits.latestStart, "f")}.`
    );
  }
  return `That overlaps with <@${result.slot.user_id}>'s timeslot (${range(result.slot)}). Pick a time that doesn't.`;
}

async function handleSubmit(interaction, board) {
  if (!isForceLeader(interaction)) return ephemeral(interaction, "Only force leaders can pick a timeslot.");
  const store = getStore();
  const userId = interaction.user.id;
  const timeZone = store.getUserTimeZone(userId) ?? getConfig().timeZone;
  const time = parseClock(interaction.fields.getTextInputValue(TIME_INPUT_ID));
  if (!time) return ephemeral(interaction, "That start time doesn't look right. Use the 24-hour clock, like 18:30.");
  const [dateValue] = interaction.fields.getStringSelectValues(DATE_INPUT_ID);
  const [year, month, day] = dateValue.split("-").map(Number);

  const now = Date.now();
  const limits = pickLimits(board);
  const startsAt = zonedDateTime({ year, month, day }, time, timeZone);
  const result = checkPick({
    startsAt,
    durationMs: limits.durationMs,
    eventStart: board.event_start,
    minGapMs: limits.minGapMs,
    slots: store.getTimeslots(board.id),
    userId,
    now,
  });
  if (result) return ephemeral(interaction, problemText(result, limits, timeZone, now));
  if (!store.pickTimeslot(board.id, userId, startsAt, startsAt + limits.durationMs)) {
    return ephemeral(interaction, "Your turn has already started, so you can't change your timeslot.");
  }

  await ephemeral(
    interaction,
    `Your timeslot is ${ts(startsAt, "f")}–${ts(startsAt + limits.durationMs)}. ` +
      "You'll be pinged in this channel when it's your turn."
  );
  await editBoardMessage(interaction.client, board).catch((error) =>
    console.error(`Timeslot board ${board.id} error:`, error)
  );
  await processBoardSafely(interaction.client, board);
}

async function handleRelease(interaction, board) {
  const store = getStore();
  const mine = myTimeslot(board, interaction.user.id);
  if (!mine) return ephemeral(interaction, "You don't have a timeslot here.");
  if (mine.reminded_at) return ephemeral(interaction, "Your turn has already started. Press **I'm done** instead.");
  store.releaseTimeslot(board.id, interaction.user.id);
  await interaction.update(renderBoard(board, store.getTimeslots(board.id)));
  return ephemeral(interaction, `You gave up your timeslot (${range(mine)}).`);
}

async function startNextEarly(client, board) {
  const next = nextEarlySlot(getStore().getTimeslots(board.id), Date.now(), EARLY_START_WINDOW_MS);
  if (!next) return;
  const channel = await client.channels.fetch(board.channel_id);
  await sendReminder(channel, board, next, true);
}

async function handleDone(interaction, board, index) {
  const store = getStore();
  const slot = store.getTimeslots(board.id).find((s) => s.slot_index === index);
  if (!slot) return ephemeral(interaction, "That timeslot no longer exists.");
  const isOwner = slot.user_id === interaction.user.id;
  if (!isOwner && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return ephemeral(interaction, "Only the force leader with this timeslot can press this.");
  }
  if (!store.markTimeslotDone(board.id, index)) {
    return ephemeral(interaction, "This timeslot is already marked as done.");
  }
  await interaction.update({
    content: `${interaction.message.content}\nDone at ${ts(Date.now())}${isOwner ? "" : ` (marked by ${interaction.user})`}`,
    components: [],
    allowedMentions: { parse: [] },
  });
  if (board.status === "open") {
    await startNextEarly(interaction.client, board).catch((error) =>
      console.error(`Timeslot board ${board.id} error:`, error)
    );
  }
  await editBoardMessage(interaction.client, board).catch(() => {});
}

async function handleComponent(interaction) {
  const [, action, boardId, extra] = interaction.customId.split(":");
  const board = getStore().getTimeslotBoard(Number(boardId));
  if (!board) return ephemeral(interaction, "This timeslot board no longer exists.");
  if (action === "done") return handleDone(interaction, board, Number(extra));
  if (board.status !== "open" || Date.now() >= board.event_start) {
    return ephemeral(interaction, "These timeslots are closed.");
  }
  if (action === "pick") return handlePick(interaction, board);
  if (action === "zone") return handleZoneButton(interaction, board);
  if (action === "setzone" && interaction.isStringSelectMenu()) return handleSetZone(interaction, board, extra);
  if (action === "submit" && interaction.isModalSubmit()) return handleSubmit(interaction, board);
  if (action === "release") return handleRelease(interaction, board);
}

module.exports = { PREFIX, renderBoard, startTimeslotSweeper, handleComponent };
