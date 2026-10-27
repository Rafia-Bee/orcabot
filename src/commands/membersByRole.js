const { SlashCommandBuilder, AttachmentBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("membersbyrole")
    .setDescription(
      "List server nickname and Discord name for every member with a given role"
    )
    .addStringOption((option) =>
      option
        .setName("role")
        .setDescription("Role name to search for")
        .setRequired(true)
    ),
  async execute(interaction) {
    const roleName = interaction.options.getString("role");
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({
        content: "This command must be used in a server.",
        ephemeral: true,
      });
    }
    const role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === roleName.toLowerCase()
    );
    if (!role) {
      return interaction.reply({
        content: `Role "${roleName}" not found.`,
        ephemeral: true,
      });
    }
    await guild.members.fetch(); // Ensure all members are cached
    const membersWithRole = guild.members.cache.filter((member) =>
      member.roles.cache.has(role.id)
    );
    if (membersWithRole.size === 0) {
      return interaction.reply({
        content: `No members found with role "${roleName}".`,
        ephemeral: true,
      });
    }
    let reply = `Members with role "${roleName}":\n`;
    let fileContent = "";
    membersWithRole.forEach((member) => {
      const ign = member.displayName;
      const discordTag = member.user.tag;
      const discordId = member.user.id;
      reply += `- Nickname: ${ign}, Discord: ${discordTag} (ID: ${discordId})\n`;
      // CSV: nickname,discordTag,discordId
      fileContent += `${ign},${discordTag},${discordId}\n`;
    });
    // Write to file
    const fs = require("fs");
    const filePath = "members-with-role.txt";
    try {
      fs.writeFileSync(filePath, fileContent, "utf8");
    } catch (err) {
      console.error("Error writing to file:", err);
    }

    // Use flags for ephemeral
    const EPHEMERAL_FLAG = 1 << 6;

    if (reply.length <= 2000) {
      await interaction.reply({ content: reply, flags: EPHEMERAL_FLAG });
    } else {
      const attachment = new AttachmentBuilder(filePath);
      await interaction.reply({
        content: `Too many members to display. See attached file.`,
        files: [attachment],
        flags: EPHEMERAL_FLAG,
      });
    }
  },
};
