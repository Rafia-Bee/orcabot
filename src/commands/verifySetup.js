const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");
const {
  CUSTOM_ID_PREFIX,
  getConfig,
  buildVerifyPanel,
  handleComponent,
} = require("../verification/interactions");
const { missingKeys } = require("../verification/config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verify-setup")
    .setDescription("Post the verification button in the verify channel")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  customIdPrefix: CUSTOM_ID_PREFIX,
  handleComponent,
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return interaction.reply({
        content: "You need the Manage Server permission to do this.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const config = getConfig();
    const missing = missingKeys(config);
    if (missing.length > 0) {
      return interaction.reply({
        content: `Verification isn't configured. Missing in .env: ${missing.join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let channel;
    try {
      channel = await interaction.guild.channels.fetch(config.verifyChannelId);
      await channel.send(buildVerifyPanel());
    } catch (error) {
      console.error("verify-setup failed:", error);
      return interaction.reply({
        content:
          "Couldn't post in the verify channel. Check VERIFY_CHANNEL_ID and that I can view and send messages there.",
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: `Verification panel posted in ${channel}. Mode: **${config.mode}**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
