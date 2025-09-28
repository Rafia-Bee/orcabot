const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("giverolebyrole")
    .setDescription("Give everyone with a specific role another role")
    .addStringOption((option) =>
      option
        .setName("fromrole")
        .setDescription("Role to give from")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("torole").setDescription("Role to give").setRequired(true)
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return interaction.reply({
        content: "You do not have permission to manage roles.",
        ephemeral: true,
      });
    }
    const fromRoleName = interaction.options.getString("fromrole");
    const toRoleName = interaction.options.getString("torole");
    try {
      await interaction.guild.members.fetch();
      const fromRole = interaction.guild.roles.cache.find(
        (r) => r.name === fromRoleName
      );
      if (!fromRole) {
        return interaction.reply(`Role "${fromRoleName}" not found.`);
      }
      const toRole = interaction.guild.roles.cache.find(
        (r) => r.name === toRoleName
      );
      if (!toRole) {
        return interaction.reply(`Role "${toRoleName}" not found.`);
      }
      let given = 0;
      for (const [memberId, member] of fromRole.members) {
        if (!member.roles.cache.has(toRole.id)) {
          try {
            await member.roles.add(toRole);
            console.log(`Gave role "${toRoleName}" to ${member.user.tag}`);
            given++;
          } catch (err) {
            console.log(
              `Failed to give role to ${member.user.tag}: ${err.message}`
            );
          }
        } else {
          console.log(
            `${member.user.tag} already has the role "${toRoleName}"`
          );
        }
      }
      return interaction.reply(
        `Gave role "${toRoleName}" to ${given} member(s) with the role "${fromRoleName}".`
      );
    } catch (error) {
      console.error("Error giving roles:", error);
      return interaction.reply("An error occurred while giving roles.");
    }
  },
};
