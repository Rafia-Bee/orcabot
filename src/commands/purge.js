const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete a number of recent messages")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of messages to delete (2-100)")
        .setRequired(true)
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageMessages
      )
    ) {
      return interaction.reply({
        content: "You do not have permission to manage messages.",
        ephemeral: true,
      });
    }
    const amount = interaction.options.getInteger("amount");
    if (amount < 2 || amount > 100) {
      return interaction.reply(
        "You can only delete between 2 and 100 messages at once."
      );
    }
    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      return interaction.reply(`Deleted ${deleted.size} message(s).`);
    } catch (error) {
      console.error("Error purging messages:", error);
      return interaction.reply("An error occurred while deleting messages.");
    }
  },
};
