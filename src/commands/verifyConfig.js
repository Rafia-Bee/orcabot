const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  EmbedBuilder,
} = require("discord.js");
const {
  getConfig,
  missingKeys,
  EDITABLE_SETTINGS,
  updateSetting,
} = require("../verification/config");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");

const channel = (id) => (id ? `<#${id}>` : "not set");
const role = (id) => (id ? `<@&${id}>` : "not set");
const PANEL_SETTINGS = new Set(["MIN_LEVEL", "MIN_GS"]);

function buildSettingsEmbed() {
  const cfg = getConfig();
  const missing = missingKeys(cfg);
  return new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle("Verification settings")
    .setDescription(
      "Min level, min gear score, min account age and archived ticket retention can be changed with " +
        "`/verify-config setting value`. Everything else: edit .env and restart the bot." +
        (missing.length ? `\n\n**Missing:** ${missing.join(", ")}` : "")
    )
    .addFields(
      { name: "Mode", value: cfg.mode, inline: true },
      { name: "Faction", value: cfg.requiredFaction, inline: true },
      { name: "Server", value: cfg.requiredServer, inline: true },
      { name: "Min level", value: String(cfg.minLevel), inline: true },
      { name: "Min gear score", value: String(cfg.minGearScore), inline: true },
      { name: "Min account age", value: `${cfg.minAccountAgeDays} days`, inline: true },
      {
        name: "Role grant delay",
        value: `${cfg.grantDelayMinSeconds}–${cfg.grantDelayMaxSeconds} s`,
        inline: true,
      },
      { name: "Submit cooldown", value: `${cfg.submitCooldownSeconds} s`, inline: true },
      {
        name: "Archived tickets kept",
        value: `${cfg.archivedTicketRetentionDays} days`,
        inline: true,
      },
      { name: "Verified role", value: role(cfg.verifiedRoleId), inline: true },
      { name: "Officers role", value: role(cfg.officersRoleId), inline: true },
      { name: "Verify channel", value: channel(cfg.verifyChannelId), inline: true },
      { name: "Log channel", value: channel(cfg.logChannelId), inline: true },
      { name: "Review channel", value: channel(cfg.reviewChannelId), inline: true },
      { name: "Tickets category", value: channel(cfg.ticketsCategoryId), inline: true },
      {
        name: "Archive category",
        value: channel(cfg.archivedTicketsCategoryId),
        inline: true,
      },
      { name: "Ticket gear slots", value: cfg.ticketGearSlots.join(", ") },
      {
        name: "shugo.gg",
        value: `${cfg.shugo.baseUrl}/${cfg.shugo.regionPath}/<name> · 1 request per ${cfg.shugo.minRequestGapMs} ms`,
      }
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verify-config")
    .setDescription("Show the verification settings, or change one")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles)
    .addStringOption((option) =>
      option
        .setName("setting")
        .setDescription("Setting to change (leave empty to just show the settings)")
        .addChoices(
          ...Object.entries(EDITABLE_SETTINGS).map(([key, { label }]) => ({
            name: label,
            value: key,
          }))
        )
    )
    .addIntegerOption((option) =>
      option.setName("value").setDescription("New value").setMinValue(0)
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

    const key = interaction.options.getString("setting");
    const value = interaction.options.getInteger("value");

    if (key === null && value === null) {
      return interaction.reply({ embeds: [buildSettingsEmbed()], flags: MessageFlags.Ephemeral });
    }
    if (key === null || value === null) {
      return interaction.reply({
        content: "Give both a setting and a value to change it, or neither to show the settings.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const setting = EDITABLE_SETTINGS[key];
    let change;
    try {
      change = updateSetting(key, value);
    } catch (error) {
      return interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
    }

    const from = `${change.previous ?? "unset"}${setting.unit}`;
    const to = `${change.current}${setting.unit}`;
    await postLog(
      interaction.client,
      buildEventEmbed({
        color: COLORS.blue,
        title: "Setting changed",
        description: `**${setting.label}** (${key}): ${from} → ${to}, by ${interaction.user}`,
      })
    );

    return interaction.reply({
      content:
        `**${setting.label}** changed from ${from} to ${to}. Saved to .env and active now.` +
        (PANEL_SETTINGS.has(key)
          ? "\nRun /refresh-verify-channel so the Verify message shows the new requirements."
          : ""),
      flags: MessageFlags.Ephemeral,
    });
  },
};
