const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("movechannels")
    .setDescription(
      "Move multiple channels under a category and sync permissions"
    )
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("Name of the category to move channels to")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel1")
        .setDescription("First channel to move")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel2")
        .setDescription("Second channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel3")
        .setDescription("Third channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel4")
        .setDescription("Fourth channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel5")
        .setDescription("Fifth channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel6")
        .setDescription("Sixth channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel7")
        .setDescription("Seventh channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel8")
        .setDescription("Eighth channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel9")
        .setDescription("Ninth channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("channel10")
        .setDescription("Tenth channel to move")
        .setRequired(false)
        .setAutocomplete(true)
    ),
  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === "category") {
      // Get all categories
      const categories = interaction.guild.channels.cache
        .filter((channel) => channel.type === 4) // 4 is ChannelType.GuildCategory
        .map((channel) => ({
          name: channel.name,
          value: channel.name,
        }));

      // Filter based on what user is typing
      const filtered = categories.filter((choice) =>
        choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
      );

      // Discord only allows 25 autocomplete options max
      await interaction.respond(filtered.slice(0, 25));
    } else if (focusedOption.name.startsWith("channel")) {
      // Get all non-category channels
      const channels = interaction.guild.channels.cache
        .filter((channel) => channel.type !== 4) // Exclude categories
        .map((channel) => ({
          name: channel.name,
          value: channel.name,
        }));

      // Filter based on what user is typing
      const filtered = channels.filter((choice) =>
        choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
      );

      // Discord only allows 25 autocomplete options max
      await interaction.respond(filtered.slice(0, 25));
    }
  },
  async execute(interaction) {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageChannels
      )
    ) {
      return interaction.reply({
        content: "You do not have permission to manage channels.",
        ephemeral: true,
      });
    }

    const categoryName = interaction.options.getString("category");

    // Collect all channel names from the options
    const channelNames = [];
    for (let i = 1; i <= 10; i++) {
      const channelName = interaction.options.getString(`channel${i}`);
      if (channelName) {
        channelNames.push(channelName);
      }
    }

    try {
      // Find the category
      const category = interaction.guild.channels.cache.find(
        (c) => c.name === categoryName && c.type === 4 // 4 is ChannelType.GuildCategory
      );

      if (!category) {
        return interaction.reply({
          content: `Category "${categoryName}" not found.`,
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      const results = {
        success: [],
        notFound: [],
        failed: [],
      };

      for (const channelName of channelNames) {
        const channel = interaction.guild.channels.cache.find(
          (c) => c.name === channelName && c.type !== 4 // Exclude categories
        );

        if (!channel) {
          results.notFound.push(channelName);
          continue;
        }

        try {
          // Move channel to category and sync permissions
          await channel.setParent(category.id, {
            lockPermissions: true, // This syncs permissions with the category
          });
          results.success.push(channelName);
          console.log(
            `Moved channel "${channelName}" to category "${categoryName}"`
          );
        } catch (err) {
          results.failed.push(channelName);
          console.error(
            `Failed to move channel "${channelName}": ${err.message}`
          );
        }
      }

      // Build response message
      let response = `**Move Channels Results:**\n`;

      if (results.success.length > 0) {
        response += `\n✅ **Successfully moved (${results.success.length}):**\n`;
        response += results.success.map((name) => `• ${name}`).join("\n");
      }

      if (results.notFound.length > 0) {
        response += `\n\n❌ **Not found (${results.notFound.length}):**\n`;
        response += results.notFound.map((name) => `• ${name}`).join("\n");
      }

      if (results.failed.length > 0) {
        response += `\n\n⚠️ **Failed to move (${results.failed.length}):**\n`;
        response += results.failed.map((name) => `• ${name}`).join("\n");
      }

      response += `\n\nAll successfully moved channels now have permissions synced with "${categoryName}".`;

      return interaction.editReply(response);
    } catch (error) {
      console.error("Error moving channels:", error);
      return interaction.editReply("An error occurred while moving channels.");
    }
  },
};
