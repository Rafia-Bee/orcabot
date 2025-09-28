const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show how many members have each role")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  async execute(interaction) {
    try {
      await interaction.guild.members.fetch();
      const roles = interaction.guild.roles.cache
        .filter((role) => role.name !== "@everyone")
        .map((role) => ({ name: role.name, count: role.members.size }))
        .sort((a, b) => b.count - a.count);

      if (roles.length === 0) {
        return interaction.reply({ content: "No roles found.", flags: 64 });
      }

      const lines = roles.map((r) => `**${r.name}**: ${r.count}`);
      const reply = lines.join("\n");
      return interaction.reply({ content: reply, flags: 64 }); // 64 = ephemeral
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "There was an error while executing this command!",
          flags: 64,
        });
      } else {
        await interaction.reply({
          content: "There was an error while executing this command!",
          flags: 64,
        });
      }
    }
  },
};
