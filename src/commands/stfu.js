const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stfu")
    .setDescription("Shut down the bot (owner only)"),
  async execute(interaction) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "You do not have permission to shut down the bot.",
        ephemeral: true,
      });
    }
    await interaction.reply("I'll shut up...");
    process.exit(0);
  },
};
