# OrcaBot

OrcaBot is a Discord bot for the Orca guild, providing moderation and utility features.

## Features

- Unban all users banned from the server with a single command
- Mass kick users by role
- Purge messages
- Rename roles
- Give roles by role (from up to 10 source roles)
- Give a role to every member, built for large servers
- Remove a role from members who have none of a set of roles
- Move channels into a category
- Show member stats for each role

## Prerequisites

- Node.js (version 14 or higher)
- A Discord bot token

## Installation

1. Clone the repository:

   ```bash
   git clone <repository-url>
   ```

2. Navigate to the project directory:

   ```bash
   cd orcabot
   ```

3. Install the dependencies:

   ```bash
   npm install
   ```

## Configuration

1. Create a `.env` file in the root directory.
2. Add your Discord bot token and IDs to the `.env` file:

   ```env
   BOT_TOKEN=your-bot-token-here
   CLIENT_ID=your-bot-client-id-here
   GUILD_ID=your-server-id-here
   BOT_OWNER_ID=your-discord-user-id-here
   ```

**Do not commit your `.env` file to version control.**

| Variable       | Where to find it                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`    | Developer Portal → your application → **Bot** → **Reset Token**                                    |
| `CLIENT_ID`    | Developer Portal → your application → **General Information** → **Application ID**                |
| `GUILD_ID`     | Discord (Developer Mode on) → right-click the server icon → **Copy Server ID**                    |
| `BOT_OWNER_ID` | Discord (Developer Mode on) → right-click your own name → **Copy User ID**                         |

To enable Developer Mode: Discord **User Settings → Advanced → Developer Mode**.

## Adding the Bot to a New Server

The slash commands are registered to **one server at a time** (the one in `GUILD_ID`), so each new server needs the steps below.

### 1. Enable the required intents

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and open your application.
2. Open the **Bot** tab.
3. Under **Privileged Gateway Intents**, turn on **Server Members Intent** (the bot uses `GuildMembers`).
4. Click **Save Changes**.

### 2. Generate the invite link

1. In the Developer Portal, open **OAuth2 → URL Generator**.
2. Under **Scopes**, tick `bot` and `applications.commands`.
3. Under **Bot Permissions**, tick:
   - Manage Roles
   - Kick Members
   - Ban Members
   - Manage Messages
   - Manage Channels
   - Read Message History
   - View Channels
   - Send Messages
   (or **Administrator** if you prefer one switch).
4. Copy the generated URL at the bottom.

> If the **Bot** tab has **Public Bot** turned off, only the application owner can invite it. Leave it off if you want to keep the bot private to servers you control.

### 3. Invite the bot

1. Paste the URL into your browser.
2. Choose the new server from the dropdown (you need **Manage Server** permission there).
3. Click **Authorize** and complete the captcha.
4. The bot now appears in the member list (offline until you start it).

### 4. Point the bot at the new server

1. In Discord, right-click the new server's icon → **Copy Server ID**.
2. Set it in `.env`:

   ```env
   GUILD_ID=the-new-server-id
   ```

### 5. Register the slash commands

Run this from the project directory:

```bash
node deploy-commands.js
```

You should see `Successfully reloaded guild application (/) commands.`

Notes:

- The script clears all **global** commands and then registers the commands to the server in `GUILD_ID` only. Guild commands appear instantly.
- Re-run it whenever you add, remove, or change a command, or switch `GUILD_ID` to a different server.
- Running it for a new `GUILD_ID` does **not** remove the commands from the previous server; they stay registered there until you remove them (or kick the bot).

### 6. Start the bot

```bash
npm start
```

The console should print `Logged in as <bot name>`. The bot must be running for slash commands to work.

### 7. Set the role hierarchy

In the new server go to **Server Settings → Roles** and drag the bot's role **above** any role it needs to manage, give roles, or kick members from. Discord will refuse role changes and kicks on roles equal to or higher than the bot's role.

### 8. Use the slash commands

1. In any channel the bot can see, type `/` and pick a command from the OrcaBot list (or keep typing, e.g. `/stats`).
2. Fill in the options Discord shows, then press **Enter**.
3. You (the person running the command) also need the matching permission, see the table below.

If the commands don't appear, see [Troubleshooting](#troubleshooting).

## Usage

Start the bot:

```bash
npm start
```

## Available Slash Commands

| Command           | What it does                                                           | Permission you need |
| ----------------- | ---------------------------------------------------------------------- | ------------------- |
| `/unbanall`       | Unban all users from the server                                        | Ban Members         |
| `/kickbyrole`     | Kick all users with a specific role                                    | Kick Members        |
| `/giverolebyrole` | Give a role to everyone who has any of up to 10 source roles           | Manage Roles        |
| `/bulkrole`       | Give a role to every member (bots only with `includebots:true`)        | Manage Roles        |
| `/trimrole`       | Remove a role from members who have none of up to 10 "keep" roles      | Manage Roles        |
| `/purge`          | Bulk delete recent messages                                            | Manage Messages     |
| `/renameguild`    | Rename a role                                                          | Manage Roles        |
| `/movechannels`   | Move up to 10 channels into a category                                 | Manage Channels     |
| `/membersbyrole`  | List members matching a role name                                      | -                   |
| `/stats`          | Show how many members have each role                                   | Manage Server       |
| `/goodboy`        | Compliment a member                                                    | -                   |
| `/stfu`           | Shut down the bot (owner only, uses `BOT_OWNER_ID`)                    | Bot owner           |

### Command details

**`/giverolebyrole torole:@New fromrole1:@A [fromrole2..fromrole10]`**
Gives `torole` to every member who has at least one of the `fromrole` roles and doesn't already have it. Slash commands can't take a list, so the source roles are numbered options; only `fromrole1` is required.

**`/bulkrole role:@Role [includebots]`**
Gives the role to every member. Bots are skipped unless `includebots` is true, and members who already have the role are skipped. Works on large servers: the reply is deferred, the member fetch waits up to 120 seconds, roles are assigned 5 at a time, and progress is shown every 50 members. Each member who receives the role is logged to the console. The reply ends with the number of non-bot members and how many of them have the role.

**`/trimrole role:@A keep1:@X [keep2..keep10] [includebots]`**
Removes role A from every member who has it but has none of the `keep` roles. Bots are skipped unless `includebots` is true. Removals are logged to the console, and the same large-server handling as `/bulkrole` applies.

`/bulkrole` and `/trimrole` refuse to run if the role is `@everyone`, is managed by an integration, or is not below both the bot's highest role and yours (the server owner is exempt from the last check).

> After adding or changing any command, run `node deploy-commands.js` and restart the bot so Discord picks up the new options.

## Troubleshooting

- **Slash commands don't show up**: make sure you invited the bot with the `applications.commands` scope, `GUILD_ID` matches the server you're in, and you ran `node deploy-commands.js`. Restart Discord (Ctrl+R) to refresh the command list.
- **`Missing Access` (50001) when deploying**: the bot isn't in that server yet, or `GUILD_ID` is wrong.
- **`Used disallowed intents`**: enable **Server Members Intent** in the Developer Portal (step 1).
- **"Unknown interaction" / `GuildMembersTimeout`**: the member fetch timed out, usually because **Server Members Intent** is off (step 1) or the server is very large.
- **`Missing Permissions` when running a command**: raise the bot's role above the target roles (step 7) and check it has the permission the command needs.
- **"The application did not respond"**: the bot isn't running. Start it with `npm start`.
- **Invalid token**: reset the token in the Developer Portal and update `BOT_TOKEN` in `.env`.

## License

This project is licensed under the MIT License.
