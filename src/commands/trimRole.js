const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

const BATCH_SIZE = 5;
const PROGRESS_EVERY = 50;
const MAX_KEEP_ROLES = 10;

const builder = new SlashCommandBuilder()
  .setName("trimrole")
  .setDescription(
    "Remove a role from members who have none of the given roles"
  )
  .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
  .addRoleOption((option) =>
    option
      .setName("role")
      .setDescription("Role to remove from members")
      .setRequired(true)
  );

// Slash commands can't take a list option, so expose numbered role options.
for (let i = 1; i <= MAX_KEEP_ROLES; i++) {
  builder.addRoleOption((option) =>
    option
      .setName(`keep${i}`)
      .setDescription(
        `Role ${i}: members with this role keep the role${i === 1 ? "" : " (optional)"}`
      )
      .setRequired(i === 1)
  );
}
builder.addBooleanOption((option) =>
  option
    .setName("includebots")
    .setDescription("Also remove the role from bots (default: false)")
);

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

    const role = interaction.options.getRole("role");
    const includeBots = interaction.options.getBoolean("includebots") ?? false;
    const guild = interaction.guild;

    const keepRoles = [];
    for (let i = 1; i <= MAX_KEEP_ROLES; i++) {
      const r = interaction.options.getRole(`keep${i}`);
      if (r && !keepRoles.some((k) => k.id === r.id)) keepRoles.push(r);
    }

    if (role.id === guild.id || role.managed) {
      return interaction.reply({
        content: "That role can't be removed manually.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (keepRoles.some((r) => r.id === role.id)) {
      return interaction.reply({
        content: "The role to remove can't also be one of the roles to keep.",
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
        content: "You can't remove a role that is higher than or equal to yours.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      const members = await guild.members.fetch({ time: 120000 });
      const keepNames = keepRoles.map((r) => r.name).join(", ");

      // Members who have role A but none of the keep roles.
      const targets = [...members.values()].filter(
        (m) =>
          m.roles.cache.has(role.id) &&
          (includeBots || !m.user.bot) &&
          !keepRoles.some((k) => m.roles.cache.has(k.id))
      );

      console.log(
        `[trimrole] "${role.name}" in ${guild.name}: ${targets.length} member(s) have none of [${keepNames}]`
      );

      if (targets.length === 0) {
        return interaction.editReply(
          `Nobody to trim: every member with "${role.name}" has at least one of: ${keepNames}.`
        );
      }

      let removed = 0;
      let failed = 0;
      let processed = 0;
      let lastProgress = 0;

      for (let i = 0; i < targets.length; i += BATCH_SIZE) {
        const batch = targets.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((m) =>
            m.roles.remove(role, `trimrole by ${interaction.user.tag}`)
          )
        );
        for (const [idx, r] of results.entries()) {
          const member = batch[idx];
          if (r.status === "fulfilled") {
            removed++;
            console.log(
              `[trimrole] Removed "${role.name}" from ${member.user.tag} (${member.id})`
            );
          } else {
            failed++;
            console.log(
              `[trimrole] Failed to remove role from ${member.user.tag} (${member.id}): ${r.reason?.message}`
            );
          }
        }
        processed += batch.length;

        if (processed - lastProgress >= PROGRESS_EVERY) {
          lastProgress = processed;
          await interaction
            .editReply(
              `Removing "${role.name}"... ${processed}/${targets.length}`
            )
            .catch(() => {});
        }
      }

      const summary = `Removed "${role.name}" from ${removed} member(s) who have none of: ${keepNames}${
        failed ? `, ${failed} failed` : ""
      }.`;
      console.log(`[trimrole] Done. ${summary}`);
      await interaction.editReply(summary).catch(async () => {
        await interaction.channel?.send(summary).catch(() => {});
      });
    } catch (error) {
      console.error("Error in trimrole:", error);
      await interaction
        .editReply("An error occurred while removing roles.")
        .catch(() => {});
    }
  },
};
