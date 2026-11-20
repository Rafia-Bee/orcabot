// /announce-roster: previews a raid-helper comp's forces, then gives out the force roles and pings each force.
//   prunePreviews     forgets previews that have expired
//   clip              shortens text to fit an embed field
//   groupRange        "groups 1-4" for a force's parties
//   describeForce     one force's preview lines
//   buildPreviewEmbed the private preview shown before anything changes
//   previewButtons    the Post roster and Cancel buttons
//   describeResult    the summary shown after posting
//   handleComponent   handles the Post roster and Cancel buttons
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("../verification/config");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");
const { parseRaidHelperId, fetchComp } = require("../roster/comp");
const { planRoster, applyRoster } = require("../roster/forceVcs");

const PREFIX = "roster";
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_FIELD_LENGTH = 1024;
const MAX_FIELDS = 24;

const previews = new Map();

function prunePreviews(now = Date.now()) {
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= now) previews.delete(token);
  }
}

function clip(text, max = MAX_FIELD_LENGTH) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function groupRange(groups) {
  if (groups.length === 0) return "no groups";
  return groups.length === 1 ? `group ${groups[0]}` : `groups ${groups[0]}–${groups[groups.length - 1]}`;
}

function describeForce(force) {
  const lines = [
    force.channelId ? `VC: <#${force.channelId}>` : `⚠️ ${force.channelProblem}, skipped`,
    force.leaderId ? `Leader: <@${force.leaderId}>` : "⚠️ No Force Leader in this force",
    `Members: ${force.memberIds.length} (${groupRange(force.groups)})`,
  ];
  if (force.otherLeaderIds.length) {
    lines.push(`Other Force Leaders: ${force.otherLeaderIds.map((id) => `<@${id}>`).join(" ")}`);
  }
  if (force.skipped.length) {
    lines.push(`Skipped: ${force.skipped.map((s) => `${escapeMarkdown(s.name)} (${s.why})`).join(", ")}`);
  }
  return clip(lines.join("\n"));
}

function buildPreviewEmbed(plan) {
  const cfg = getConfig();
  const active = plan.forces.filter((force) => force.memberIds.length || force.skipped.length);
  const empty = plan.forces.filter((force) => !active.includes(force));
  const embed = new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle(`Roster preview: ${plan.title}`)
    .setDescription(
      `Nothing has changed yet. **Post roster** gives each member their force role, which opens their force's voice channel, ` +
        `and posts the pings in <#${cfg.roster.channelId}>.`
    );
  for (const force of active.slice(0, MAX_FIELDS)) {
    embed.addFields({ name: clip(force.name || "Unnamed force", 256), value: describeForce(force) });
  }
  const notes = [];
  if (active.length > MAX_FIELDS) notes.push(`${active.length - MAX_FIELDS} more forces not shown.`);
  if (empty.length) notes.push(`Empty forces (nobody gets their role): ${empty.map((f) => f.name).join(", ")}`);
  if (plan.unassigned.length) {
    notes.push(`Not under any force, skipped: ${plan.unassigned.map(escapeMarkdown).join(", ")}`);
  }
  if (plan.clearedChannelIds.length) {
    notes.push(`No force this time, so nobody gets their role: ${plan.clearedChannelIds.map((id) => `<#${id}>`).join(" ")}`);
  }
  if (notes.length) embed.addFields({ name: "Also", value: clip(notes.join("\n")) });
  return embed;
}

function previewButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:confirm:${token}`).setLabel("Post roster").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
}

function describeResult(plan, result) {
  const lines = [
    `Posted ${result.posted} force roster${result.posted === 1 ? "" : "s"} for **${escapeMarkdown(plan.title)}**.`,
    `Force roles given: ${result.given}. Taken off (not in this roster): ${result.removed}.`,
  ];
  if (result.problems.length) lines.push(`Problems:\n${result.problems.map((p) => `- ${p}`).join("\n")}`);
  return clip(lines.join("\n"), 2000);
}

async function handleComponent(interaction) {
  if (!interaction.isButton()) return;
  const [, action, token] = interaction.customId.split(":");
  const preview = previews.get(token);
  if (!preview || preview.expiresAt <= Date.now()) {
    previews.delete(token);
    return interaction.update({
      content: "This preview has expired. Run /announce-roster again.",
      embeds: [],
      components: [],
    });
  }
  if (interaction.user.id !== preview.userId) {
    return interaction.reply({
      content: "Only the person who ran /announce-roster can use these buttons.",
      flags: MessageFlags.Ephemeral,
    });
  }
  previews.delete(token);

  if (action === "cancel") {
    return interaction.update({ content: "Cancelled. Nothing was changed.", embeds: [], components: [] });
  }

  await interaction.update({ content: "Giving out force roles and posting…", components: [] });
  let result;
  try {
    result = await applyRoster(interaction.guild, preview.plan, interaction.user);
  } catch (error) {
    if (error.code !== "ROSTER_BUSY") throw error;
    return interaction.editReply({ content: error.message, embeds: [] });
  }
  const summary = describeResult(preview.plan, result);
  await interaction.editReply({ content: summary, embeds: [], allowedMentions: { parse: [] } });
  await postLog(
    interaction.client,
    buildEventEmbed({
      color: result.problems.length ? COLORS.yellow : COLORS.green,
      title: "Force roster posted",
      description: `<@${interaction.user.id}> posted comp ${preview.plan.compId}.\n${summary}`.slice(0, 4096),
    })
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("announce-roster")
    .setDescription("Give a raid-helper comp's members their force roles and ping each force")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addStringOption((option) =>
      option.setName("comp").setDescription("The raid-helper comp ID or link").setRequired(true).setMaxLength(200)
    ),
  customIdPrefix: PREFIX,
  handleComponent,
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({
        content: "You need the Manage Channels permission to do this.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const cfg = getConfig();
    if (!cfg.roster.forceVcCategoryId || !cfg.roster.channelId) {
      return interaction.reply({
        content: "Set the Force voice category and Roster channel in /settings first.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const compId = parseRaidHelperId(interaction.options.getString("comp"));
    if (!compId) {
      return interaction.reply({
        content: "That doesn't look like a raid-helper comp ID or link.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let comp;
    try {
      comp = await fetchComp(compId, { apiKey: cfg.roster.raidHelperApiKey, userAgent: cfg.lookup.userAgent });
    } catch (error) {
      return interaction.editReply(`Couldn't load comp ${compId}: ${error.message}`);
    }
    if (!comp.dividers?.length) {
      return interaction.editReply("This comp has no dividers, so there are no forces to announce.");
    }

    const plan = await planRoster(interaction.guild, comp);
    prunePreviews();
    const token = crypto.randomBytes(8).toString("hex");
    previews.set(token, { plan, userId: interaction.user.id, expiresAt: Date.now() + PREVIEW_TTL_MS });
    const ready = plan.forces.some((force) => force.channelId && force.memberIds.length);
    return interaction.editReply({
      content: ready ? undefined : "⚠️ No force has a matching voice channel, force role and members.",
      embeds: [buildPreviewEmbed(plan)],
      components: [previewButtons(token)],
      allowedMentions: { parse: [] },
    });
  },
};
