const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { reasonText } = require("../verification/embeds");
const { primarySource } = require("../verification/lookup");
const {
  recheckClaim,
  runFullRecheck,
  getRunningRecheck,
} = require("../verification/recheck");

function describeOne(result) {
  const name = `**${escapeMarkdown(result.claim.char_name)}**`;
  switch (result.status) {
    case "left":
      return `<@${result.claim.discord_id}> isn't in the server anymore. Nothing changed.`;
    case "not_verified":
      return `<@${result.claim.discord_id}> doesn't have the Verified role. Nothing changed.`;
    case "lookup_failed":
      return `Couldn't look up ${name}: ${result.reason}. Try again later.`;
    case "review":
      return result.alreadyOpen
        ? `${name}: ${reasonText(result.reason)}. They already have an open review case.`
        : `${name}: ${reasonText(result.reason)}. Opened review case #${result.caseId} in the review channel.`;
    case "updated":
      return (
        `${name} updated: ${result.changes.join(", ")}.` +
        (result.problems.length ? `\nProblems: ${result.problems.join("; ")}` : "")
      );
    default:
      return (
        `${name} is unchanged. Roles checked.` +
        (result.problems.length ? `\nProblems: ${result.problems.join("; ")}` : "")
      );
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("recheck-members")
    .setDescription("Re-check verified members' characters and update their legion and class roles")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addUserOption((option) =>
      option.setName("user").setDescription("Re-check just this member (leave empty for everyone)")
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
    const user = interaction.options.getUser("user");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (user) {
      const claim = store.getVerification(user.id);
      if (!claim) {
        return interaction.editReply({
          content: `${user} hasn't claimed a character.`,
          allowedMentions: { parse: [] },
        });
      }
      const result = await recheckClaim(interaction.client, interaction.guild, claim);
      return interaction.editReply({ content: describeOne(result), allowedMentions: { parse: [] } });
    }

    const current = getRunningRecheck();
    if (current) {
      return interaction.editReply({
        content: `A re-check started by <@${current.startedBy}> is already running (${current.done} of ${current.total} done).`,
        allowedMentions: { parse: [] },
      });
    }

    const total = store.getAllVerifications().length;
    if (total === 0) {
      return interaction.editReply("No verified members have a claimed character yet.");
    }

    const minutes = Math.max(1, Math.ceil((total * primarySource().minRequestGapMs()) / 60_000));
    runFullRecheck(interaction.client, interaction.guild, interaction.user.id).catch((error) =>
      console.error("Member re-check failed:", error)
    );
    return interaction.editReply(
      `Re-checking ${total} verified member${total === 1 ? "" : "s"} in the background. ` +
        `This takes about ${minutes} min. The results will be posted in <#${getConfig().logChannelId}>.`
    );
  },
};
