# OrcaBot

A Discord bot for the Orca guild. It checks new members' AION 2 characters so only our faction gets into the server, and it has a handful of mod tools for roles, channels and cleanup.

## What you need

- [Node.js](https://nodejs.org) 22 or newer
- A Discord bot (make one at the [Discord Developer Portal](https://discord.com/developers/applications))
- Somewhere for it to run 24/7. The bot only works while it's running. We use Fly.io, see [Hosting on Fly.io](#hosting-on-flyio).

## Setup

### 1. Download and install

```bash
git clone <repository-url>
cd orcabot
npm install
```

### 2. Set up the bot on Discord

In the [Developer Portal](https://discord.com/developers/applications), open your bot:

1. **Bot** tab: turn on **Server Members Intent** and save.
2. **OAuth2 → URL Generator**: tick `bot` and `applications.commands`, then tick these permissions (or just **Administrator**):
   - Manage Roles, Manage Nicknames, Manage Channels, Manage Messages
   - Kick Members, Ban Members
   - View Channels, Send Messages, Read Message History, Attach Files, Embed Links
3. Open the link it gives you, pick your server, and click **Authorize**.

### 3. Fill in the settings

Copy `.env.example` to a new file called `.env` and fill in the blanks. Every line has a comment explaining what it's for.

To copy IDs, turn on **Developer Mode** in Discord (**User Settings → Advanced**), then right-click a server, channel, category, role or user and pick **Copy ID**.

You'll need:

| Setting | What it is |
| --- | --- |
| `BOT_TOKEN` | Developer Portal → **Bot** → **Reset Token**. Keep it secret. |
| `CLIENT_ID` | Developer Portal → **General Information** → **Application ID** |
| `GUILD_ID` | Your server's ID |
| `BOT_OWNER_ID` | Your own user ID (lets you use `/stfu`) |
| `VERIFIED_ROLE_ID` | The role that unlocks the server |
| `OFFICERS_ROLE_ID` | The role that handles review tickets |
| `LEGION_ROLES` | *(optional)* Your alliance legions and their roles, like `Aegis:<role id>,SDC:<role id>`. The names must match shugo.gg. |
| `GUEST_ROLE_ID` | *(optional)* The role for verified members who aren't in one of those legions |
| `VERIFY_CHANNEL_ID` | Where new members click **Verify** |
| `VERIFY_LOG_CHANNEL_ID` | Mods-only log of everything the bot does |
| `VERIFY_REVIEW_CHANNEL_ID` | Mods-only channel for cases that need a human |
| `REVIEW_TICKETS_CATEGORY_ID` | Category for open review tickets |
| `ARCHIVED_REVIEW_TICKETS_CATEGORY_ID` | Category closed tickets get moved to |

The rest (faction, server, level and gear score requirements, and so on) already have sensible values. It's worth setting `SHUGO_HEALTHCHECK_CHARACTER` to your own character: the bot looks it up on startup and warns you in the log channel if character lookups stop working.

Never share your `.env` file. It's already left out of git.

### 4. Set up your server

- **Channels:** make the verify channel, the log and review channels, and the two ticket categories (open and archived).
- **Who sees what:**
  - The verify channel: everyone can see it, but `Verified` can't.
  - The log and review channels: mods only.
  - The ticket categories: officers only. The bot handles the rest.
  - Everything else in the server: `Verified` only.
- **Role order:** in **Server Settings → Roles**, drag the bot's role **above** `Verified`, the legion and Guest roles, and any other role it should hand out. The bot can't change roles or nicknames for anyone at or above its own role.

### 5. Register the commands and start the bot

```bash
node deploy-commands.js
npm start
```

You should see `Logged in as ...`. Run `node deploy-commands.js` again whenever the bot gets new commands.

### 6. Post the Verify button

Run `/verify-setup` in Discord. The bot posts the Verify message in your verify channel.

## Hosting on Fly.io

Fly.io keeps the bot running around the clock for about $2.34 a month (the smallest machine plus 1 GB of storage). The bot's settings (`.env`) and saved data live on that storage, so they survive restarts and updates.

### First-time setup

1. **Sign up** at [fly.io](https://fly.io) with your GitHub account and add a payment card.
2. **Install the Fly tool** and log in:
   - Windows (PowerShell): `iwr https://fly.io/install.ps1 -useb | iex`
   - Mac/Linux: `curl -L https://fly.io/install.sh | sh`
   - Then: `fly auth login`
3. **Create the app** from the project folder:
   ```bash
   fly apps create orcabot
   ```
   If the name `orcabot` is taken, pick another one and change `app = "orcabot"` at the top of `fly.toml` to match.
4. **Create the storage** (say yes if it warns about having only one volume):
   ```bash
   fly volumes create orcabot_data --region fra --size 1
   ```
5. **Deploy:**
   ```bash
   fly deploy
   ```
   The bot starts and waits for its settings.
6. *(Optional)* **Bring your existing data along.** Stop the bot on your PC first, then:
   ```bash
   fly ssh sftp put data/orcabot.db /data/orcabot.db
   ```
7. **Upload your settings:**
   ```bash
   fly ssh sftp put .env /data/.env -m 0600
   ```
   Within 10 seconds the bot starts. Check with `fly logs`. You should see `Logged in as ...`.
8. **Stop the bot on your PC.** If two copies run at once, members get double replies.

### Automatic updates from GitHub

Every push to `main` can test and deploy the bot by itself:

1. Run `fly tokens create deploy` and copy the token.
2. On GitHub, open the repo → **Settings → Secrets and variables → Actions → New repository secret**. Name it `FLY_API_TOKEN` and paste the token.

That's it. Pushes to `main` now deploy automatically (you can watch them in the repo's **Actions** tab).

### Day to day

- **See what the bot is doing:** `fly logs`
- **Restart it:** `fly apps restart orcabot`
- **Change a setting that `/verify-config` can't:** the copy on Fly.io is the live one, since mods' `/verify-config` changes are saved there. So download it, edit it, and put it back:
  ```bash
  fly ssh sftp get /data/.env server.env
  # edit server.env
  fly ssh console -C "rm /data/.env"
  fly ssh sftp put server.env /data/.env -m 0600
  fly apps restart orcabot
  ```
  Delete `server.env` from your PC afterwards, since it contains the bot token.
- **New or changed commands:** still run `node deploy-commands.js` from your PC.

## How verification works

1. A new member clicks **Verify** and types their in-game character name.
2. The bot looks the character up and decides:
   - **Everything checks out:** they get `Verified` and their nickname is set to the character name, after a short random wait.
   - **Level or gear score too low, with strict verification on (`STRICT_VERIFICATION=true`):** they're told they don't meet the server requirements, and why.
   - **Discord account is too new, or the character's level or gear score is too low (strict verification off):** the bot opens a private ticket with the member and the officers. It asks for an in-game screenshot with a random gear piece taken off. An officer clicks **Verify** or **Ban**, and the ticket is archived.
   - **Wrong faction or server:** they're turned away.
   - **Typo or unknown name:** they're asked to try again.
   - **Anything unusual** (the name's already claimed by someone else, or the lookup site is down): it goes to the review channel with **Approve** and **Deny** buttons.
3. Along with `Verified`, members get their legion's role, or Guest if their legion isn't in the alliance (only if `LEGION_ROLES` / `GUEST_ROLE_ID` are set). If someone changes legion, use `/verify-manual` on them again to swap the role.
4. Each character can only belong to one Discord account.
5. Archived tickets are deleted after 7 days without messages.
6. If a flood of Verify requests comes in at once (a raid), the bot pauses verification for a few minutes and warns the mods. Members are asked to try again shortly.

Members never see how the checks work. All the details go to the mods-only channels.

**Trying it out first:** set `VERIFY_MODE=shadow` in `.env`. The bot then only posts what it *would* do in the log channel and doesn't change anything. Switch to `live` when you're happy.

## Commands

### Verification

| Command | What it does | Who can use it |
| --- | --- | --- |
| `/verify-setup` | Post the Verify message | Manage Server |
| `/refresh-verify-channel` | Replace the Verify message, e.g. after changing requirements | Manage Server |
| `/verify-manual` | Verify someone by hand with their character name (also closes their open ticket or review case) | Manage Roles |
| `/unverify` | Take away someone's Verified role, nickname and character | Manage Roles |
| `/whois-char` | See who owns a character, or which character someone has | Manage Roles |
| `/verify-config` | See the settings, turn strict verification on or off, or change the min level, gear score, account age or how long archived tickets are kept | Manage Roles |

### Mod tools

| Command | What it does | Who can use it |
| --- | --- | --- |
| `/bulkrole` | Give a role to every member | Manage Roles |
| `/giverolebyrole` | Give a role to everyone who has any of up to 10 other roles | Manage Roles |
| `/trimrole` | Remove a role from everyone who has none of up to 10 "keep" roles | Manage Roles |
| `/renameguild` | Rename a role | Manage Roles |
| `/kickbyrole` | Kick everyone with a role | Kick Members |
| `/unbanall` | Unban everyone | Ban Members |
| `/purge` | Delete recent messages | Manage Messages |
| `/movechannels` | Move up to 10 channels into a category | Manage Channels |
| `/stats` | Show how many members have each role | Manage Server |
| `/membersbyrole` | List everyone with a role | Anyone |
| `/goodboy` | Compliment someone | Anyone |
| `/stfu` | Shut the bot down | Bot owner only |

## Testing

- `npm run dev`: starts the bot with a blank slate every time. Nothing is saved, and members can retry straight away.
- `npm run db:reset`: wipes the bot's saved data (stop the bot first).
- `npm test`: runs the automated checks.

Saved data doesn't include Discord itself. Test accounts keep their roles and nicknames, so use `/unverify` to reset them.

## Something's not working?

- **Commands don't show up:** run `node deploy-commands.js`, check `GUILD_ID` is your server, then press Ctrl+R in Discord.
- **"The application did not respond":** the bot isn't running. Start it with `npm start`.
- **"Missing Permissions":** move the bot's role higher (step 4) and check it has the permissions from step 2.
- **"Used disallowed intents":** turn on **Server Members Intent** (step 2).
- **The bot won't start and lists missing settings:** fill those in `.env`.
- **Invalid token:** reset it in the Developer Portal and update `BOT_TOKEN`.

## License

MIT
