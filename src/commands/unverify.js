const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { revokeAccess } = require("../verification/access");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unverify")
    .setDescription("Remove a member's Verified role, nickname and character claim")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addUserOption((option) =>
      option.setName("user").setDescription("Member to unverify").setRequired(true)
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return interaction.reply({
        content: "You need the Manage Roles permission to do this.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = getConfig();
    const store = getStore();
    const user = interaction.options.getUser("user");
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const claim = store.getVerification(user.id);
    const hadGrant = store.deleteScheduledGrant(user.id);
    const hadRole = member?.roles.cache.has(cfg.verifiedRoleId) ?? false;
    if (!claim && !hadGrant && !hadRole) {
      return interaction.editReply({
        content: `${user} isn't verified and has no character claim.`,
        allowedMentions: { parse: [] },
      });
    }

    store.deleteVerification(user.id);
    const problems = member ? await revokeAccess(member) : [];

    const what = claim ? `**${escapeMarkdown(claim.char_name)}**` : "no claimed character";
    await postLog(
      interaction.client,
      buildEventEmbed({
        color: COLORS.red,
        title: "Unverified",
        description: `${user} (${what}), by ${interaction.user}`,
        fields: problems.length ? [{ name: "Problems", value: problems.join("\n") }] : [],
      })
    );

    return interaction.editReply({
      content:
        `Unverified ${user} (${what}).` +
        (member ? "" : " They're not in the server, so only the claim was removed.") +
        (problems.length ? `\nProblems: ${problems.join("; ")}` : ""),
      allowedMentions: { parse: [] },
    });
  },
};
