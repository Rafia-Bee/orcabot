const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  StringSelectMenuBuilder,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { COLORS } = require("../verification/embeds");
const { isActive, pickableSlots, dueSlots, nextEarlySlot, isFinished } = require("./schedule");

const PREFIX = "timeslot";
const SWEEP_INTERVAL_MS = 15_000;
const OPTIONS_PER_MENU = 25;
const MAX_MENUS = 4;
const UNKNOWN_MESSAGE = 10008;

const ts = (ms, style = "t") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const range = (slot) => `${ts(slot.starts_at)}–${ts(slot.ends_at)}`;

function slotLine(slot, now) {
  const number = `\`${String(slot.slot_index + 1).padStart(2, " ")}\``;
  if (slot.user_id === null) return `${number} ${range(slot)} · free`;
  const state = slot.done_at !== null ? " · Done" : isActive(slot, now) ? " · Now editing" : "";
  return `${number} ${range(slot)} · <@${slot.user_id}>${state}`;
}

function renderBoard(board, slots, now = Date.now()) {
  const finished = board.status !== "open" || isFinished(slots, now);
  const embed = new EmbedBuilder()
    .setColor(finished ? COLORS.grey : COLORS.blue)
    .setTitle(`Comp editing timeslots: ${board.title}`.slice(0, 256))
    .setDescription(
      [
        `Event starts ${ts(board.event_start, "F")}.`,
        finished
          ? "These timeslots are closed."
          : "Force leaders: pick one timeslot below. You'll be pinged here when it's your turn. " +
            "Press **I'm done** when you've finished editing the comp, so the next force leader can start early.",
        "",
        ...slots.map((slot) => slotLine(slot, now)),
      ]
        .join("\n")
        .slice(0, 4096)
    );
  if (finished) return { embeds: [embed], components: [] };

  const pickable = pickableSlots(slots, now).slice(0, OPTIONS_PER_MENU * MAX_MENUS);
  const rows = [];
  for (let i = 0; i < pickable.length; i += OPTIONS_PER_MENU) {
    const chunk = pickable.slice(i, i + OPTIONS_PER_MENU);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}:pick:${board.id}:${i / OPTIONS_PER_MENU}`)
          .setPlaceholder(
            pickable.length > OPTIONS_PER_MENU
              ? `Pick a timeslot (${chunk[0].slot_index + 1}–${chunk[chunk.length - 1].slot_index + 1})`
              : "Pick a timeslot"
          )
          .addOptions(
            chunk.map((slot) => ({
              label: `Timeslot ${slot.slot_index + 1}`,
              description: "Time is in the list above",
              value: String(slot.slot_index),
            }))
          )
      )
    );
  }
  if (rows.length === 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}:pick:${board.id}:none`)
          .setPlaceholder("No free timeslots left")
          .setDisabled(true)
          .addOptions({ label: "No free timeslots left", value: "none" })
      )
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:release:${board.id}`)
        .setLabel("Give up my timeslot")
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return { embeds: [embed], components: rows };
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

async function processBoard(client, board) {
  const store = getStore();
  const now = Date.now();
  let slots = store.getTimeslots(board.id);

  if (isFinished(slots, now)) {
    store.closeTimeslotBoard(board.id);
    await editBoardMessage(client, { ...board, status: "closed" });
    return;
  }

  const channel = await client.channels.fetch(board.channel_id);
  let changed = false;
  for (const slot of dueSlots(slots, now)) {
    await sendReminder(channel, board, slot, false);
    changed = true;
  }
  slots = store.getTimeslots(board.id);
  const early = nextEarlySlot(slots, now);
  if (early) {
    await sendReminder(channel, board, early, true);
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

async function handlePick(interaction, board) {
  const cfg = getConfig();
  if (!cfg.forceLeaderRoleId || !interaction.member.roles.cache.has(cfg.forceLeaderRoleId)) {
    return ephemeral(interaction, "Only force leaders can pick a timeslot.");
  }
  const store = getStore();
  const slots = store.getTimeslots(board.id);
  const mine = slots.find((slot) => slot.user_id === interaction.user.id);
  if (mine?.reminded_at) {
    return ephemeral(interaction, "Your turn has already started, so you can't switch timeslots.");
  }
  const index = Number(interaction.values[0]);
  const target = pickableSlots(slots).find((slot) => slot.slot_index === index);
  if (!target || !store.claimTimeslot(board.id, index, interaction.user.id)) {
    await interaction.update(renderBoard(board, store.getTimeslots(board.id)));
    return ephemeral(interaction, "Someone else just took that timeslot, or it's no longer available. Pick another one.");
  }
  await interaction.update(renderBoard(board, store.getTimeslots(board.id)));
  await ephemeral(
    interaction,
    `You have timeslot ${index + 1} (${range(target)}).` +
      (mine ? ` Timeslot ${mine.slot_index + 1} is free again.` : "") +
      " You'll be pinged in this channel when it's your turn."
  );
  await processBoardSafely(interaction.client, board);
}

async function handleRelease(interaction, board) {
  const store = getStore();
  const mine = store.getTimeslots(board.id).find((slot) => slot.user_id === interaction.user.id);
  if (!mine) return ephemeral(interaction, "You don't have a timeslot here.");
  if (mine.reminded_at) return ephemeral(interaction, "Your turn has already started. Press **I'm done** instead.");
  store.releaseTimeslot(board.id, interaction.user.id);
  await interaction.update(renderBoard(board, store.getTimeslots(board.id)));
  return ephemeral(interaction, `You gave up timeslot ${mine.slot_index + 1}.`);
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
  await editBoardMessage(interaction.client, board).catch(() => {});
  await processBoardSafely(interaction.client, board);
}

async function handleComponent(interaction) {
  const [, action, boardId, extra] = interaction.customId.split(":");
  const board = getStore().getTimeslotBoard(Number(boardId));
  if (!board) return ephemeral(interaction, "This timeslot board no longer exists.");
  if (action === "done") return handleDone(interaction, board, Number(extra));
  if (board.status !== "open") return ephemeral(interaction, "These timeslots are closed.");
  if (action === "pick" && interaction.isStringSelectMenu()) return handlePick(interaction, board);
  if (action === "release") return handleRelease(interaction, board);
}

module.exports = { PREFIX, renderBoard, startTimeslotSweeper, handleComponent };
