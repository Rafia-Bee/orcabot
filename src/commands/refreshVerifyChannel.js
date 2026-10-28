const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");
const { OPEN_BUTTON_ID, buildVerifyPanel } = require("../verification/interactions");
const { getConfig, missingKeys } = require("../verification/config");

function isVerifyPanel(message, botId) {
  return (
    message.author.id === botId &&
    message.components.some((row) =>
      row.components?.some((component) => component.customId === OPEN_BUTTON_ID)
    )
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("refresh-verify-channel")
    .setDescription("Delete the current verification message and post a fresh one")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let channel;
    let deleted = 0;
    try {
      channel = await interaction.guild.channels.fetch(config.verifyChannelId);
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages.values()) {
        if (isVerifyPanel(message, interaction.client.user.id)) {
          await message.delete();
          deleted++;
        }
      }
      await channel.send(buildVerifyPanel());
    } catch (error) {
      console.error("refresh-verify-channel failed:", error);
      return interaction.editReply(
        `Couldn't refresh the verify channel: ${error.message}. Check VERIFY_CHANNEL_ID and that I can view, read history and send messages there.`
      );
    }

    return interaction.editReply(
      `Deleted ${deleted} old verification message${deleted === 1 ? "" : "s"} and posted a new one in ${channel}.`
    );
  },
};
