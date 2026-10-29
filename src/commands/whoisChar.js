const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");
const { getStore } = require("../verification/store");
const { buildClaimEmbed } = require("../verification/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("whois-char")
    .setDescription("Show which member claimed a character, or which character a member claimed")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addStringOption((option) =>
      option.setName("name").setDescription("In-game character name").setMaxLength(64)
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("Member")
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

    const store = getStore();
    const name = interaction.options.getString("name")?.trim();
    const user = interaction.options.getUser("user");
    if (!name && !user) {
      return interaction.reply({
        content: "Give a character name, a member, or both.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const claims = [];
    if (name) {
      const claim = store.getVerificationByCharName(name);
      claims.push(claim ?? `No one has claimed **${escapeMarkdown(name)}**.`);
    }
    if (user) {
      const claim = store.getVerification(user.id);
      if (!claims.some((c) => c?.discord_id === user.id)) {
        claims.push(claim ?? `${user} hasn't claimed a character.`);
      }
    }

    const embeds = [];
    const lines = [];
    for (const claim of claims) {
      if (typeof claim === "string") {
        lines.push(claim);
        continue;
      }
      const member = await interaction.guild.members.fetch(claim.discord_id).catch(() => null);
      embeds.push(buildClaimEmbed(claim, member));
    }

    return interaction.reply({
      content: lines.join("\n") || undefined,
      embeds,
      allowedMentions: { parse: [] },
    });
  },
};
