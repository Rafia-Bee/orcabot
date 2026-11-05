// /roster-reminder: pings the members of a raid-helper comp who aren't in their force's voice channel yet.
// execute: loads the comp, posts the reminders in the roster channel and replies with a summary.
const { SlashCommandBuilder, PermissionsBitField, MessageFlags, escapeMarkdown } = require("discord.js");
const { getConfig } = require("../verification/config");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");
const { parseRaidHelperId, fetchComp } = require("../roster/comp");
const { planRoster, remindRoster } = require("../roster/forceVcs");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("roster-reminder")
    .setDescription("Ping the members of a raid-helper comp who aren't in their force's voice channel yet")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addStringOption((option) =>
      option.setName("comp").setDescription("The raid-helper comp ID or link").setRequired(true).setMaxLength(200)
    ),
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
        content: "Set FORCE_VC_CATEGORY_ID and ROSTER_CHANNEL_ID in .env first.",
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
      return interaction.editReply("This comp has no dividers, so there are no forces to check.");
    }

    const plan = await planRoster(interaction.guild, comp);
    const result = await remindRoster(interaction.guild, plan);

    const lines = [
      result.pinged === 0
        ? `Everyone in **${escapeMarkdown(plan.title)}** is already in their force's voice channel. Nobody was pinged.`
        : `Pinged ${result.pinged} member${result.pinged === 1 ? "" : "s"} across ${result.posted} force${result.posted === 1 ? "" : "s"} ` +
          `for **${escapeMarkdown(plan.title)}** in <#${cfg.roster.channelId}>.`,
    ];
    if (result.pinged > 0 && result.allPresent.length) {
      lines.push(`Everyone's already in: ${result.allPresent.map(escapeMarkdown).join(", ")}`);
    }
    const noChannel = plan.forces.filter((force) => !force.channelId && force.memberIds.length);
    if (noChannel.length) {
      lines.push(`Skipped (no matching voice channel): ${noChannel.map((force) => escapeMarkdown(force.name)).join(", ")}`);
    }
    if (result.problems.length) lines.push(`Problems:\n${result.problems.map((p) => `- ${p}`).join("\n")}`);
    const summary = lines.join("\n").slice(0, 2000);
    await interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
    await postLog(
      interaction.client,
      buildEventEmbed({
        color: result.problems.length ? COLORS.yellow : COLORS.green,
        title: "Roster reminder sent",
        description: `<@${interaction.user.id}> sent a reminder for comp ${plan.compId}.\n${summary}`.slice(0, 4096),
      })
    );
  },
};
