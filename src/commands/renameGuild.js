const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("renameguild")
    .setDescription("Rename a role")
    .addStringOption((option) =>
      option
        .setName("oldrolename")
        .setDescription("Current role name")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("newrolename")
        .setDescription("New role name")
        .setRequired(true)
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return interaction.reply({
        content: "You do not have permission to rename roles.",
        ephemeral: true,
      });
    }
    const oldRoleName = interaction.options.getString("oldrolename");
    const newRoleName = interaction.options.getString("newrolename");
    try {
      const role = interaction.guild.roles.cache.find(
        (r) => r.name === oldRoleName
      );
      if (!role) {
        return interaction.reply(`Role "${oldRoleName}" not found.`);
      }
      await role.setName(newRoleName);
      console.log(`Renamed role "${oldRoleName}" to "${newRoleName}"`);
      return interaction.reply(
        `Renamed role from "${oldRoleName}" to "${newRoleName}".`
      );
    } catch (error) {
      console.error("Error renaming guild:", error);
      return interaction.reply(
        "An error occurred while renaming the guild role."
      );
    }
  },
};
