# OrcaBot

OrcaBot is a Discord bot for the Orca guild, providing moderation and utility features.

## Features

- Unban all users banned from the server with a single command
- Mass kick users by role
- Purge messages
- Rename the guild
- Give roles by role

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
2. Add your Discord bot token to the `.env` file:

   ```env
   DISCORD_TOKEN=your-bot-token-here
   ```

**Do not commit your `.env` file to version control.**

## Usage

Start the bot:

```bash
npm start
```

## Available Commands

- `!unbanAll` — Unban all users from the server
- `!kickByRole` — Kick all users with a specific role
- `!giveRoleByRole` — Give a role to all users with another role
- `!purge` — Bulk delete messages
- `!renameGuild` — Rename the server

## Contributing

Feel free to submit issues or pull requests for any improvements or features you'd like to see!

## License

This project is licensed under the MIT License.
