// Creates one force role per voice channel in the force category, with the Verified role's permissions,
// and lets each role see and join its own voice channel. Safe to run again: existing roles are reused.
// Shows what it would do by default. Add --write to make the changes.
//   hasAccess   true when a channel already lets the role see and join it
//   main        finds the voice channels and roles, then creates and fixes what's missing

require("dotenv").config({ path: process.env.ENV_FILE, quiet: true });
const { REST, Routes, ChannelType, OverwriteType, PermissionFlagsBits } = require("discord.js");
const { getConfig } = require("../src/verification/config");
const { channelKey, forceRoleName } = require("../src/roster/comp");

const ACCESS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect;
const write = process.argv.includes("--write");

function hasAccess(overwrite) {
  return Boolean(overwrite) && (BigInt(overwrite.allow) & ACCESS) === ACCESS && (BigInt(overwrite.deny) & ACCESS) === 0n;
}

async function main() {
  const guildId = process.env.GUILD_ID;
  const cfg = getConfig();
  const categoryId = cfg.roster.forceVcCategoryId;
  if (!process.env.BOT_TOKEN || !guildId) throw new Error("BOT_TOKEN and GUILD_ID must be set in .env.");
  if (!cfg.verifiedRoleId) throw new Error("Set the Verified role in /settings first.");
  if (!categoryId) throw new Error("Set the Force voice category in /settings first.");

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  const [roles, channels] = await Promise.all([
    rest.get(Routes.guildRoles(guildId)),
    rest.get(Routes.guildChannels(guildId)),
  ]);
  const verified = roles.find((role) => role.id === cfg.verifiedRoleId);
  if (!verified) throw new Error("The Verified role set in /settings doesn't exist anymore.");

  const voiceChannels = channels
    .filter((channel) => channel.parent_id === categoryId && channel.type === ChannelType.GuildVoice)
    .sort((a, b) => a.position - b.position);
  console.log(
    `${voiceChannels.length} voice channel(s) in the force category.` +
      (write ? "" : " Dry run: nothing is changed. Add --write to make the changes.")
  );

  const reason = "Force roles setup";
  for (const channel of voiceChannels) {
    const key = channelKey(channel.name);
    let role = roles.find((r) => r.id !== guildId && !r.managed && channelKey(r.name) === key);
    const steps = [];

    if (!role) {
      steps.push(`create role "${forceRoleName(channel.name)}"`);
      if (write) {
        role = await rest.post(Routes.guildRoles(guildId), {
          body: { name: forceRoleName(channel.name), permissions: verified.permissions, hoist: false, mentionable: false },
          reason,
        });
        roles.push(role);
      }
    } else if (role.permissions !== verified.permissions) {
      steps.push(`copy Verified's permissions to "${role.name}"`);
      if (write) await rest.patch(Routes.guildRole(guildId, role.id), { body: { permissions: verified.permissions }, reason });
    }

    const overwrite = role && channel.permission_overwrites.find((o) => o.id === role.id);
    if (!hasAccess(overwrite)) {
      steps.push("let the role see and join the channel");
      if (write) {
        await rest.put(Routes.channelPermission(channel.id, role.id), {
          body: {
            type: OverwriteType.Role,
            allow: String(BigInt(overwrite?.allow ?? 0) | ACCESS),
            deny: String(BigInt(overwrite?.deny ?? 0) & ~ACCESS),
          },
          reason,
        });
      }
    }

    console.log(`  ${channel.name}: ${steps.length ? steps.join(", ") : "already set up"}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
