const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("goodboy")
    .setDescription("Compliment a member")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("The member to compliment")
        .setRequired(true)
    ),
  async execute(interaction) {
    const member = interaction.options.getUser("member");
    await interaction.reply(`Good boy, <@${member.id}>`);
  },
};
