// /reset-force-vcs: takes every force role off everyone after an event, so the force voice channels close again.
const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require("discord.js");
const { getConfig } = require("../verification/config");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");
const { resetForceVcs } = require("../roster/forceVcs");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("reset-force-vcs")
    .setDescription("Take the force roles off everyone after an event")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({
        content: "You need the Manage Channels permission to do this.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!getConfig().roster.forceVcCategoryId) {
      return interaction.reply({
        content: "Set the Force voice category in /settings first.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let result;
    try {
      result = await resetForceVcs(interaction.guild, interaction.user);
    } catch (error) {
      if (error.code !== "ROSTER_BUSY") throw error;
      return interaction.editReply(error.message);
    }

    const lines = [
      result.roles === 0
        ? "No force roles found. Run the create-force-roles script first."
        : result.removed === 0
          ? "Nobody had a force role. Nothing to reset."
          : `Took the force roles off ${result.removed} member${result.removed === 1 ? "" : "s"}.`,
    ];
    if (result.problems.length) lines.push(`Problems:\n${result.problems.map((p) => `- ${p}`).join("\n")}`);
    const summary = lines.join("\n").slice(0, 2000);
    await interaction.editReply(summary);
    await postLog(
      interaction.client,
      buildEventEmbed({
        color: result.problems.length ? COLORS.yellow : COLORS.green,
        title: "Force voice channels reset",
        description: `<@${interaction.user.id}>: ${summary}`.slice(0, 4096),
      })
    );
  },
};
