const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
    new SlashCommandBuilder()
        .setName('unbanall')
        .setDescription('Unban all users from the server'),
    new SlashCommandBuilder()
        .setName('kickbyrole')
        .setDescription('Kick all members with a specific role')
        .addStringOption(option =>
            option.setName('role')
                .setDescription('Role to kick')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('renameguild')
        .setDescription('Rename a role')
        .addStringOption(option =>
            option.setName('oldrolename')
                .setDescription('Current role name')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('newrolename')
                .setDescription('New role name')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete a number of recent messages')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of messages to delete (2-100)')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('giverolebyrole')
        .setDescription('Give everyone with a specific role another role')
        .addStringOption(option =>
            option.setName('fromrole')
                .setDescription('Role to give from')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('torole')
                .setDescription('Role to give')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('stfu')
        .setDescription('Shut down the bot (owner only)'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();