const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

const BATCH_SIZE = 5;
const PROGRESS_EVERY = 50;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("bulkrole")
    .setDescription("Give a role to every member of the server")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addRoleOption((option) =>
      option.setName("role").setDescription("Role to give").setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName("includebots")
        .setDescription("Also give the role to bots (default: false)")
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return interaction.reply({
        content: "You do not have permission to manage roles.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const role = interaction.options.getRole("role");
    const includeBots = interaction.options.getBoolean("includebots") ?? false;
    const guild = interaction.guild;

    if (role.id === guild.id || role.managed) {
      return interaction.reply({
        content: "That role can't be assigned manually.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (role.position >= guild.members.me.roles.highest.position) {
      return interaction.reply({
        content:
          "That role is higher than (or equal to) my highest role. Move my role above it in Server Settings → Roles.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (
      interaction.user.id !== guild.ownerId &&
      role.position >= interaction.member.roles.highest.position
    ) {
      return interaction.reply({
        content: "You can't give a role that is higher than or equal to yours.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      // Long timeout so large servers have time to stream all member chunks.
      const members = await guild.members.fetch({ time: 120000 });
      const targets = [...members.values()].filter(
        (m) => !m.roles.cache.has(role.id) && (includeBots || !m.user.bot)
      );

      const humans = members.filter((m) => !m.user.bot);
      const totalHumans = humans.size;
      let humansWithRole = humans.filter((m) =>
        m.roles.cache.has(role.id)
      ).size;
      const statsLine = () =>
        `Members (excluding bots): ${totalHumans}\nMembers with "${role.name}" (excluding bots): ${humansWithRole}/${totalHumans}`;

      console.log(
        `[bulkrole] "${role.name}" in ${guild.name}: ${targets.length} member(s) to update`
      );

      if (targets.length === 0) {
        return interaction.editReply(
          `Everyone already has the role "${role.name}".\n${statsLine()}`
        );
      }

      let given = 0;
      let failed = 0;
      let processed = 0;
      let lastProgress = 0;

      // discord.js queues requests around Discord's rate limits, so small
      // parallel batches keep things fast without hammering the API.
      for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const batch = targets.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((m) => m.roles.add(role, `bulkrole by ${interaction.user.tag}`))
        );
        for (const [idx, r] of results.entries()) {
          const member = batch[idx];
          if (r.status === "fulfilled") {
            given++;
            if (!member.user.bot) humansWithRole++;
            console.log(
              `[bulkrole] Gave "${role.name}" to ${member.user.tag} (${member.id})`
            );
          } else {
            failed++;
            console.log(
              `[bulkrole] Failed to give role to ${member.user.tag} (${member.id}): ${r.reason?.message}`
            );
          }
        }
        processed += batch.length;

        if (processed - lastProgress >= PROGRESS_EVERY) {
          lastProgress = processed;
          // Progress updates are best-effort; the interaction token lasts 15 min.
          await interaction
            .editReply(
              `Giving "${role.name}"... ${processed}/${targets.length}`
            )
            .catch(() => {});
        }
      }

      const summary = `Gave "${role.name}" to ${given} member(s)${
        failed ? `, ${failed} failed` : ""
      }.\n${statsLine()}`;
      console.log(`[bulkrole] Done. ${summary.replace(/\n/g, " | ")}`);
      await interaction.editReply(summary).catch(async () => {
        // Token expired on very long runs; fall back to a normal message.
        await interaction.channel?.send(summary).catch(() => {});
      });
    } catch (error) {
      console.error("Error in bulkrole:", error);
      await interaction
        .editReply("An error occurred while giving roles.")
        .catch(() => {});
    }
  },
};
