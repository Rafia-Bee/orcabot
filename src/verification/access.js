const { escapeMarkdown } = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { COLORS, buildEventEmbed, postLog } = require("./embeds");

const SWEEP_INTERVAL_MS = 15_000;

async function grantAccess(member, charName) {
  const cfg = getConfig();
  const problems = [];

  try {
    await member.roles.add(cfg.verifiedRoleId, `Verified as ${charName}`);
  } catch (error) {
    problems.push(`role: ${error.message}`);
  }

  if (member.id === member.guild.ownerId || !member.manageable) {
    problems.push("nickname: member is above the bot's role");
  } else if (member.nickname !== charName) {
    try {
      await member.setNickname(charName, "Verified character name");
    } catch (error) {
      problems.push(`nickname: ${error.message}`);
    }
  }

  return { roleGranted: !problems.some((p) => p.startsWith("role")), problems };
}

function randomGrantDelayMs() {
  const { grantDelayMinSeconds: min, grantDelayMaxSeconds: max } = getConfig();
  return (min + Math.random() * (max - min)) * 1000;
}

async function processGrant(client, grant) {
  const store = getStore();
  store.deleteScheduledGrant(grant.discord_id);

  const guild = client.guilds.cache.get(grant.guild_id);
  const member = guild
    ? await guild.members.fetch(grant.discord_id).catch(() => null)
    : null;

  if (!member) {
    await postLog(
      client,
      buildEventEmbed({
        color: COLORS.grey,
        title: "👋 Left before role was granted",
        description: `<@${grant.discord_id}> (**${escapeMarkdown(grant.char_name)}**) is no longer in the server. Their claim is kept.`,
      })
    );
    return;
  }

  const { roleGranted, problems } = await grantAccess(member, grant.char_name);
  if (problems.length > 0) {
    await postLog(
      client,
      buildEventEmbed({
        color: roleGranted ? COLORS.yellow : COLORS.red,
        title: roleGranted ? "⚠ Verified with problems" : "❌ Couldn't grant Verified role",
        description: `<@${member.id}> (**${escapeMarkdown(grant.char_name)}**)`,
        fields: [{ name: "Problems", value: problems.join("\n") }],
      })
    );
  }
}

function startGrantSweeper(client) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      for (const grant of getStore().getDueGrants()) {
        await processGrant(client, grant);
      }
    } catch (error) {
      console.error("Grant sweeper error:", error);
    } finally {
      running = false;
    }
  };
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = { grantAccess, randomGrantDelayMs, startGrantSweeper };
