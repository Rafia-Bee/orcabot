const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("kickbyrole")
    .setDescription("Kick all members with a specific role")
    .addStringOption((option) =>
      option.setName("role").setDescription("Role to kick").setRequired(true)
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.KickMembers)
    ) {
      return interaction.reply({
        content: "You do not have permission to kick members.",
        ephemeral: true,
      });
    }
    const roleName = interaction.options.getString("role");
    try {
      await interaction.guild.members.fetch();
      const role = interaction.guild.roles.cache.find(
        (r) => r.name === roleName
      );
      if (!role) {
        return interaction.reply(`Role "${roleName}" not found.`);
      }
      const membersWithRole = role.members;
      let kicked = 0;
      for (const [memberId, member] of membersWithRole) {
        if (!member.kickable) {
          console.log(
            `Cannot kick: ${member.user.tag} (${member.id}) - Not kickable`
          );
          continue;
        }
        console.log(`Kicking member: ${member.user.tag} (${member.id})`);
        await member.kick(`Mass kick by role: ${roleName}`);
        kicked++;
      }
      return interaction.reply(
        `Kicked ${kicked} member(s) with the role "${roleName}".`
      );
    } catch (error) {
      console.error("Error kicking members:", error);
      return interaction.reply("An error occurred while kicking members.");
    }
  },
};
