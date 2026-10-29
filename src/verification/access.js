const { escapeMarkdown } = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { COLORS, buildEventEmbed, postLog } = require("./embeds");

const SWEEP_INTERVAL_MS = 15_000;

function legionRolesEnabled(cfg) {
  return cfg.legionRoles.length > 0 || Boolean(cfg.guestRoleId);
}

function roleFor(map, fallbackRoleId, value) {
  if (value === undefined) return undefined;
  const key = (value ?? "").trim().toLowerCase();
  const match = key ? map.find((entry) => entry.name.toLowerCase() === key) : null;
  return match ? match.roleId : fallbackRoleId;
}

function legionRoleFor(cfg, legion) {
  return roleFor(cfg.legionRoles, cfg.guestRoleId, legion);
}

function classRoleFor(cfg, className) {
  return roleFor(cfg.classRoles, null, className);
}

function allianceRoleIds(cfg) {
  return [...cfg.legionRoles.map((l) => l.roleId), cfg.guestRoleId].filter(Boolean);
}

function classRoleIds(cfg) {
  return cfg.classRoles.map((c) => c.roleId);
}

async function applyMappedRole(member, { label, roleIds, target, reason }) {
  const stale = roleIds.filter((id) => id !== target && member.roles.cache.has(id));
  try {
    if (stale.length) await member.roles.remove(stale, `${label} role changed`);
    if (target && !member.roles.cache.has(target)) await member.roles.add(target, reason);
    return [];
  } catch (error) {
    return [`${label.toLowerCase()} role: ${error.message}`];
  }
}

async function applyCharacterRoles(member, character) {
  const cfg = getConfig();
  const problems = [];

  if (legionRolesEnabled(cfg)) {
    const legion = character === undefined ? undefined : character.legion ?? null;
    const target = legionRoleFor(cfg, legion);
    if (target === undefined) {
      problems.push("legion: unknown (no character data), give the legion or Guest role by hand");
    } else {
      problems.push(
        ...(await applyMappedRole(member, {
          label: "Legion",
          roleIds: allianceRoleIds(cfg),
          target,
          reason: `Legion: ${legion || "none"}`,
        }))
      );
    }
  }

  if (cfg.classRoles.length > 0) {
    const className = character === undefined ? undefined : character.className ?? null;
    const target = classRoleFor(cfg, className);
    if (target === undefined) {
      problems.push("class: unknown (no character data), give the class role by hand");
    } else {
      problems.push(
        ...(await applyMappedRole(member, {
          label: "Class",
          roleIds: classRoleIds(cfg),
          target,
          reason: `Class: ${className || "unknown"}`,
        }))
      );
    }
  }

  return problems;
}

const MAX_NICKNAME_LENGTH = 32;

function nicknameFor(charName, character) {
  const gearScore = character?.gearScore;
  if (gearScore === undefined || gearScore === null) return charName;
  const nickname = `${gearScore} - ${charName}`;
  return nickname.length <= MAX_NICKNAME_LENGTH ? nickname : charName;
}

async function grantAccess(member, charName, character) {
  const cfg = getConfig();
  const problems = [];
  const nickname = nicknameFor(charName, character);

  try {
    await member.roles.add(cfg.verifiedRoleId, `Verified as ${charName}`);
  } catch (error) {
    problems.push(`role: ${error.message}`);
  }
  if (problems.length === 0) problems.push(...(await applyCharacterRoles(member, character)));

  if (member.id === member.guild.ownerId || !member.manageable) {
    problems.push("nickname: member is above the bot's role");
  } else if (member.nickname !== nickname) {
    try {
      await member.setNickname(nickname, "Verified character name");
    } catch (error) {
      problems.push(`nickname: ${error.message}`);
    }
  }

  return { roleGranted: !problems.some((p) => p.startsWith("role")), problems };
}

async function revokeAccess(member) {
  const cfg = getConfig();
  const problems = [];

  const toRemove = [cfg.verifiedRoleId, ...allianceRoleIds(cfg), ...classRoleIds(cfg)].filter((id) =>
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

  const claim = store.getVerification(grant.discord_id);
  const { roleGranted, problems } = await grantAccess(member, grant.char_name, {
    legion: claim?.legion ?? null,
    className: claim?.class_name ?? null,
    gearScore: claim?.gear_score ?? null,
  });
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
  nicknameFor,
  applyCharacterRoles,
  revokeAccess,
  randomGrantDelayMs,
  startGrantSweeper,
  legionRoleFor,
  classRoleFor,
  legionRolesEnabled,
};
