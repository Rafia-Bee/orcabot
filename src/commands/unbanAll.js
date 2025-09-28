const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unbanall")
    .setDescription("Unban all users from the server"),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers)
    ) {
      return interaction.reply({
        content: "You do not have permission to unban members.",
        ephemeral: true,
      });
    }
    try {
      const bans = await interaction.guild.bans.fetch();
      for (const [userId, banInfo] of bans) {
        await interaction.guild.members.unban(userId);
        console.log(`Unbanned: ${banInfo.user.tag}`);
      }
      await interaction.reply("Unbanned all users.");
    } catch (error) {
      console.error("Error unbanning users:", error);
      await interaction.reply({
        content: "An error occurred while unbanning users.",
        ephemeral: true,
      });
    }
  },
};
