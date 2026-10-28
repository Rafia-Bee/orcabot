const { escapeMarkdown } = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { COLORS, buildEventEmbed, postLog } = require("./embeds");

const SWEEP_INTERVAL_MS = 15_000;

function legionRolesEnabled(cfg) {
  return cfg.legionRoles.length > 0 || Boolean(cfg.guestRoleId);
}

function legionRoleFor(cfg, legion) {
  if (legion === undefined) return undefined;
  const key = (legion ?? "").trim().toLowerCase();
  const match = key ? cfg.legionRoles.find((l) => l.name.toLowerCase() === key) : null;
  return match ? match.roleId : cfg.guestRoleId;
}

function allianceRoleIds(cfg) {
  return [...cfg.legionRoles.map((l) => l.roleId), cfg.guestRoleId].filter(Boolean);
}

async function applyLegionRole(member, legion) {
  const cfg = getConfig();
  if (!legionRolesEnabled(cfg)) return [];

  const target = legionRoleFor(cfg, legion);
  if (target === undefined) {
    return ["legion: unknown (no character data), give the legion or Guest role by hand"];
  }

  const stale = allianceRoleIds(cfg).filter((id) => id !== target && member.roles.cache.has(id));
  try {
    if (stale.length) await member.roles.remove(stale, "Legion role changed");
    if (target && !member.roles.cache.has(target)) {
      await member.roles.add(target, `Legion: ${legion || "none"}`);
    }
    return [];
  } catch (error) {
    return [`legion role: ${error.message}`];
  }
}

async function grantAccess(member, charName, legion) {
  const cfg = getConfig();
  const problems = [];

  try {
    await member.roles.add(cfg.verifiedRoleId, `Verified as ${charName}`);
  } catch (error) {
    problems.push(`role: ${error.message}`);
  }
  if (problems.length === 0) problems.push(...(await applyLegionRole(member, legion)));

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

async function revokeAccess(member) {
  const cfg = getConfig();
  const problems = [];

  const toRemove = [cfg.verifiedRoleId, ...allianceRoleIds(cfg)].filter((id) =>
    member.roles.cache.has(id)
  );
  if (toRemove.length) {
    try {
      await member.roles.remove(toRemove, "Unverified");
    } catch (error) {
      problems.push(`role: ${error.message}`);
    }
  }

  if (member.nickname && member.id !== member.guild.ownerId && member.manageable) {
    try {
      await member.setNickname(null, "Unverified");
    } catch (error) {
      problems.push(`nickname: ${error.message}`);
    }
  }

  return problems;
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
        title: "Left before role was granted",
        description: `<@${grant.discord_id}> (**${escapeMarkdown(grant.char_name)}**) is no longer in the server. Their claim is kept.`,
      })
    );
    return;
  }

  const legion = store.getVerification(grant.discord_id)?.legion ?? null;
  const { roleGranted, problems } = await grantAccess(member, grant.char_name, legion);
  if (problems.length > 0) {
    await postLog(
      client,
      buildEventEmbed({
        color: roleGranted ? COLORS.yellow : COLORS.red,
        title: roleGranted ? "Verified with problems" : "Couldn't grant Verified role",
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

module.exports = {
  grantAccess,
  revokeAccess,
  randomGrantDelayMs,
  startGrantSweeper,
  legionRoleFor,
  legionRolesEnabled,
};
