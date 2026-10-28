const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { lookupCharacter } = require("../verification/shugo");
const { grantAccess } = require("../verification/access");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");
const { closeTicketAsVerified } = require("../verification/tickets");
const { closeReviewCaseAsApproved } = require("../verification/review");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verify-manual")
    .setDescription("Verify a member by hand and claim a character for them")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addUserOption((option) =>
      option.setName("user").setDescription("Member to verify").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("In-game character name")
        .setRequired(true)
        .setMaxLength(64)
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = getConfig();
    const store = getStore();
    const user = interaction.options.getUser("user");
    const name = interaction.options.getString("name").trim();

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return interaction.editReply(`${user} isn't in the server.`);
    }

    const lookup = await lookupCharacter(name);
    if (lookup.status === "invalid_name") {
      return interaction.editReply("That isn't a valid character name.");
    }
    if (lookup.status === "not_found") {
      return interaction.editReply(
        `**${escapeMarkdown(name)}** wasn't found on shugo.gg (${cfg.requiredServer}). Check the spelling.`
      );
    }
    const character = lookup.status === "found" ? lookup.character : { name };

    try {
      store.saveVerification({
        discordId: member.id,
        character,
        method: "manual",
        reviewedBy: interaction.user.id,
      });
    } catch (error) {
      if (error.code !== "CHAR_CLAIMED") throw error;
      return interaction.editReply({
        content: `**${escapeMarkdown(character.name)}** is already claimed by <@${error.claimedBy}>. Run /unverify on them first.`,
        allowedMentions: { parse: [] },
      });
    }
    store.deleteScheduledGrant(member.id);

    const { roleGranted, problems } = await grantAccess(
      member,
      character.name,
      lookup.status === "found" ? character : undefined
    );
    if (!roleGranted) {
      store.deleteVerification(member.id);
      return interaction.editReply(`Couldn't give the Verified role: ${problems.join("; ")}`);
    }

    const notes = [...problems];
    if (lookup.status === "unavailable") {
      notes.push(`shugo.gg lookup failed (${lookup.reason}), so the name was saved as typed`);
    } else {
      const c = lookup.character;
      if (c.faction !== cfg.requiredFaction || c.server !== cfg.requiredServer) {
        notes.push(`shugo.gg shows ${c.faction} on ${c.server}`);
      }
      if (c.level < cfg.minLevel || (c.gearScore ?? 0) < cfg.minGearScore) {
        notes.push(`below requirements: level ${c.level}, gear score ${c.gearScore ?? "?"}`);
      }
    }
    const openTicket = store.getOpenTicket(member.id);
    if (openTicket) {
      const ticketProblems = await closeTicketAsVerified(interaction, openTicket);
      if (ticketProblems === null) {
        notes.push(`their ticket <#${openTicket.channel_id}> was closed by someone else at the same time`);
      } else if (ticketProblems.length) {
        notes.push(`closed their ticket <#${openTicket.channel_id}>, but: ${ticketProblems.join("; ")}`);
      } else {
        notes.push(`closed and archived their ticket <#${openTicket.channel_id}>`);
      }
    }
    const openCase = store.getOpenReviewCase(member.id);
    if (openCase) {
      const caseProblems = await closeReviewCaseAsApproved(interaction, openCase);
      if (caseProblems === null) {
        notes.push(`review case #${openCase.id} was closed by someone else at the same time`);
      } else if (caseProblems.length) {
        notes.push(`approved review case #${openCase.id}, but: ${caseProblems.join("; ")}`);
      } else {
        notes.push(`approved and closed review case #${openCase.id}`);
      }
    }

    await postLog(
      interaction.client,
      buildEventEmbed({
        color: COLORS.green,
        title: "Verified manually",
        description: `${member} as **${escapeMarkdown(character.name)}**, by ${interaction.user}`,
        fields: notes.length ? [{ name: "Notes", value: notes.join("\n").slice(0, 1024) }] : [],
      })
    );

    return interaction.editReply({
      content:
        `Verified ${member} as **${escapeMarkdown(character.name)}**.` +
        (notes.length ? `\nNote: ${notes.join("; ")}` : ""),
      allowedMentions: { parse: [] },
    });
  },
};
