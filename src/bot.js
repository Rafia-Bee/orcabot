const {
  Client,
  GatewayIntentBits,
  Collection,
  MessageFlags,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

client.commands = new Collection();
client.componentHandlers = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
    if (command.customIdPrefix && command.handleComponent) {
      client.componentHandlers.set(
        command.customIdPrefix,
        command.handleComponent
      );
    }
  } else {
    console.warn(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
    );
  }
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const command of client.commands.values()) {
    if (command.onReady) command.onReady(client);
  }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
});

// Handle client errors
client.on("error", (error) => {
  console.error("Client Error:", error);
});

client.on("interactionCreate", async (interaction) => {
  // Handle autocomplete interactions
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command || !command.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error("Autocomplete error:", error);
    }
    return;
  }

  // Handle button and modal interactions
  if (interaction.isButton() || interaction.isModalSubmit()) {
    const handler = client.componentHandlers.get(
      interaction.customId.split(":")[0]
    );
    if (!handler) return;
    try {
      await handler(interaction);
    } catch (error) {
      console.error("Component error:", error);
      const reply = {
        content: "Something went wrong. Please try again in a moment.",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
    return;
  }

  // Handle command interactions
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    return interaction.reply({
      content: "Command not found.",
      ephemeral: true,
    });
  }
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
  }
});

client.login(process.env.BOT_TOKEN);
