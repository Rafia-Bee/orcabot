const { Client, GatewayIntentBits } = require('discord.js');
const { unbanAll } = require('./commands/unbanAll');
const { kickByRole } = require('./commands/kickByRole');
const { renameGuild } = require('./commands/renameGuild');
const { purge } = require('./commands/purge');
const { giveRoleByRole } = require('./commands/giveRoleByRole');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.content === '!unbanAll') {
        if (!message.member?.permissions.has('BAN_MEMBERS')) {
            return message.reply('You do not have permission to unban members.');
        }
        await unbanAll(message.guild);
        message.channel.send('Unbanning all users...');
    }

    if (message.content.startsWith('!kickByRole ')) {
        if (!message.member?.permissions.has('KICK_MEMBERS')) {
            return message.reply('You do not have permission to kick members.');
        }
        const roleName = message.content.slice('!kickByRole '.length).trim();
        if (!roleName) {
            return message.reply('Please specify a role name.');
        }
        const result = await kickByRole(message.guild, roleName);
        message.channel.send(result);
    }

    if (message.content.startsWith('!renameGuild ')) {
        if (!message.member?.permissions.has('MANAGE_ROLES')) {
            return message.reply('You do not have permission to rename roles.');
        }
        const args = message.content.slice('!renameGuild '.length).split(',').map(s => s.trim());
        if (args.length !== 2) {
            return message.reply('Usage: !renameGuild <oldRoleName>,<newRoleName>');
        }
        const [oldRoleName, newRoleName] = args;
        const result = await renameGuild(message.guild, oldRoleName, newRoleName);
        message.channel.send(result);
    }

    if (message.content.startsWith('!purge ')) {
        if (!message.member?.permissions.has('MANAGE_MESSAGES')) {
            return message.reply('You do not have permission to manage messages.');
        }
        const amount = parseInt(message.content.split(' ')[1], 10);
        if (isNaN(amount)) {
            return message.reply('Please specify a valid number of messages to delete.');
        }
        const result = await purge(message.channel, amount);
        message.channel.send(result)
            .then(msg => setTimeout(() => msg.delete(), 3000))
            .catch(() => {});
    }

    if (message.content === '!listOnboardingQuestions') {
        const onboarding = await message.guild.fetchOnboarding();
        onboarding.prompts.forEach(prompt => {
            console.log(`ID: ${prompt.id} | Title: ${prompt.title}`);
            message.channel.send(`ID: \`${prompt.id}\`\nTitle: **${prompt.title}**`);
        });
    }

    if (message.content.startsWith('!giveRoleByRole ')) {
        if (!message.member?.permissions.has('MANAGE_ROLES')) {
            return message.reply('You do not have permission to manage roles.');
        }
        const args = message.content.slice('!giveRoleByRole '.length).split(',').map(s => s.trim());
        if (args.length !== 2) {
            return message.reply('Usage: !giveRoleByRole <fromRoleName>,<toRoleName>');
        }
        const [fromRoleName, toRoleName] = args;
        const result = await giveRoleByRole(message.guild, fromRoleName, toRoleName);
        message.channel.send(result);
    }

    if (message.content === '!stfu') {
        const ownerId = process.env.BOT_OWNER_ID;
        if (message.author.id !== ownerId) {
            return message.reply('You do not have permission to shut down the bot.');
        }
        await message.channel.send('I\'ll shut up...');
        process.exit(0);
    }
});

client.login(process.env.BOT_TOKEN);