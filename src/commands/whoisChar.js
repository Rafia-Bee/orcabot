const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  EmbedBuilder,
  escapeMarkdown,
} = require("discord.js");
const { getStore } = require("../verification/store");
const { COLORS, unixSeconds } = require("../verification/embeds");
const { characterUrl } = require("../verification/shugo");

const METHOD_TEXT = {
  auto: "Automatic",
  ticket: "Review ticket",
  manual: "Manual (/verify-manual or review queue)",
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("whois-char")
    .setDescription("Show which member claimed a character, or which character a member claimed")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addStringOption((option) =>
      option.setName("name").setDescription("In-game character name").setMaxLength(64)
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("Member")
    ),
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(PermissionsBitField.Flags.ManageRoles)
    ) {
      return interaction.reply({
        content: "You need the Manage Roles permission to do this.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const store = getStore();
    const name = interaction.options.getString("name")?.trim();
    const user = interaction.options.getUser("user");
    if (!name && !user) {
      return interaction.reply({
        content: "Give a character name, a member, or both.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const claims = [];
    if (name) {
      const claim = store.getVerificationByCharName(name);
      claims.push(claim ?? `No one has claimed **${escapeMarkdown(name)}**.`);
    }
    if (user) {
      const claim = store.getVerification(user.id);
      if (!claims.some((c) => c?.discord_id === user.id)) {
        claims.push(claim ?? `${user} hasn't claimed a character.`);
      }
    }

    const embeds = [];
    const lines = [];
    for (const claim of claims) {
      if (typeof claim === "string") {
        lines.push(claim);
        continue;
      }
      const url = characterUrl(claim.char_name);
      embeds.push(
        new EmbedBuilder()
          .setColor(COLORS.blue)
          .setTitle(claim.char_name)
          .setURL(url)
          .addFields(
            { name: "Member", value: `<@${claim.discord_id}> (${claim.discord_id})` },
            { name: "Legion", value: claim.legion ? escapeMarkdown(claim.legion) : "—", inline: true },
            { name: "Class", value: claim.class_name ?? "—", inline: true },
            { name: "Level", value: String(claim.level ?? "?"), inline: true },
            { name: "Gear score", value: String(claim.gear_score ?? "?"), inline: true },
            {
              name: "Combat power",
              value: claim.combat_power?.toLocaleString("en-US") ?? "?",
              inline: true,
            },
            { name: "Method", value: METHOD_TEXT[claim.method] ?? claim.method, inline: true },
            {
              name: "Approved by",
              value: claim.reviewed_by ? `<@${claim.reviewed_by}>` : "—",
              inline: true,
            },
            { name: "Verified", value: `<t:${unixSeconds(claim.created_at)}:f>`, inline: true },
            { name: "shugo.gg", value: `[View character](${url})` }
          )
      );
    }

    return interaction.reply({
      content: lines.join("\n") || undefined,
      embeds,
      allowedMentions: { parse: [] },
    });
  },
};
