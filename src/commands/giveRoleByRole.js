const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

const MAX_FROM_ROLES = 10;

const builder = new SlashCommandBuilder()
  .setName("giverolebyrole")
  .setDescription("Give everyone with any of the chosen roles another role")
  .addRoleOption((option) =>
    option.setName("torole").setDescription("Role to give").setRequired(true)
  );

// Slash commands can't take a list option, so expose numbered role options.
for (let i = 1; i <= MAX_FROM_ROLES; i++) {
  builder.addRoleOption((option) =>
    option
      .setName(`fromrole${i}`)
      .setDescription(
        `Role ${i}: members with this role get the new role${i === 1 ? "" : " (optional)"}`
      )
      .setRequired(i === 1)
  );
}

module.exports = {
  data: builder,
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return interaction.reply({
        content: "You do not have permission to manage roles.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const toRole = interaction.options.getRole("torole");
    const fromRoles = [];
    for (let i = 1; i <= MAX_FROM_ROLES; i++) {
      const r = interaction.options.getRole(`fromrole${i}`);
      if (r && !fromRoles.some((f) => f.id === r.id)) fromRoles.push(r);
    }
    const fromNames = fromRoles.map((r) => r.name).join(", ");

    await interaction.deferReply();
    try {
      const members = await interaction.guild.members.fetch({ time: 120000 });
      let given = 0;
      let failed = 0;
      for (const member of members.values()) {
        if (
          !fromRoles.some((r) => member.roles.cache.has(r.id)) ||
          member.roles.cache.has(toRole.id)
        ) {
          continue;
        }
        try {
          await member.roles.add(toRole);
          console.log(`Gave role "${toRole.name}" to ${member.user.tag}`);
          given++;
        } catch (err) {
          failed++;
          console.log(
            `Failed to give role to ${member.user.tag}: ${err.message}`
          );
        }
      }
      return interaction.editReply(
        `Gave role "${toRole.name}" to ${given} member(s) with any of: ${fromNames}${
          failed ? `, ${failed} failed` : ""
        }.`
      );
    } catch (error) {
      console.error("Error giving roles:", error);
      return interaction.editReply("An error occurred while giving roles.");
    }
  },
};
