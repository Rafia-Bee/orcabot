// Applies force rosters in Discord: gives each force member their force role, which opens their force voice channel.
//   exclusive             runs one roster or reset at a time
//   forceVoiceChannels    the voice channels in the force category, in order
//   forceRoles            the role for each force voice channel, matched by name
//   forceRoleIdsOf        the IDs of all the force roles
//   fetchMembers          fetches members by ID in batches
//   planRoster            matches a comp's forces to voice channels, roles and members, without changing anything
//   keptOverwrites        a channel's permissions minus the per-member ones
//   hasMemberOverwrites   true when a channel still has per-member permissions (the old way of opening channels)
//   clearMemberOverwrites removes per-member permissions from the force voice channels
//   syncForceRoles        gives and takes force roles so they match who should have them
//   applyRoster           sets the force roles and posts each force's pings
//   resetForceVcs         takes every force role off everyone after an event
//   remindRoster          pings the force members who aren't in their voice channel yet

const { ChannelType, OverwriteType } = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { buildForces, channelKey, forceRoleChanges, missingFromVoice, rosterMessages } = require("./comp");

const MEMBER_FETCH_BATCH = 100;

let busy = false;

async function exclusive(task) {
  if (busy) {
    const error = new Error("Another roster or reset is still running. Try again in a moment.");
    error.code = "ROSTER_BUSY";
    throw error;
  }
  busy = true;
  try {
    return await task();
  } finally {
    busy = false;
  }
}

async function forceVoiceChannels(guild) {
  const { forceVcCategoryId } = getConfig().roster;
  const channels = await guild.channels.fetch();
  return [
    ...channels
      .filter((channel) => channel?.parentId === forceVcCategoryId && channel.type === ChannelType.GuildVoice)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .values(),
  ];
}

async function forceRoles(guild, voiceChannels) {
  const keys = new Set(voiceChannels.map((channel) => channelKey(channel.name)));
  const roles = await guild.roles.fetch();
  const rolesByKey = new Map();
  for (const role of roles.values()) {
    const key = channelKey(role.name);
    if (role.id === guild.id || role.managed || !keys.has(key) || rolesByKey.has(key)) continue;
    rolesByKey.set(key, role);
  }
  return rolesByKey;
}

async function fetchMembers(guild, ids) {
  const members = new Map();
  for (let i = 0; i < ids.length; i += MEMBER_FETCH_BATCH) {
    const batch = await guild.members.fetch({ user: ids.slice(i, i + MEMBER_FETCH_BATCH) });
    for (const [id, member] of batch) members.set(id, member);
  }
  return members;
}

function slotLabel(slot) {
  return String(slot.name ?? slot.userId ?? "?");
}

async function planRoster(guild, comp) {
  const cfg = getConfig();
  const { forces, unassigned } = buildForces(comp);
  const voiceChannels = await forceVoiceChannels(guild);
  const rolesByKey = await forceRoles(guild, voiceChannels);
  const channelsByKey = new Map();
  for (const channel of voiceChannels) {
    const key = channelKey(channel.name);
    if (!channelsByKey.has(key)) channelsByKey.set(key, channel);
  }

  const userIds = [...new Set(forces.flatMap((force) => force.slots.map((slot) => slot.userId)).filter(Boolean))];
  const members = await fetchMembers(guild, userIds);
  const usedChannelIds = new Set();
  const claimedUserIds = new Set();

  const planned = forces.map((force) => {
    const channel = channelsByKey.get(channelKey(force.name)) ?? null;
    const channelTaken = channel && usedChannelIds.has(channel.id);
    if (channel && !channelTaken) usedChannelIds.add(channel.id);
    const role = channel && !channelTaken ? rolesByKey.get(channelKey(channel.name)) ?? null : null;
    const channelProblem = channelTaken
      ? "its voice channel is already used by another force"
      : !channel
        ? "no voice channel with this name"
        : !role
          ? "no force role for its voice channel"
          : null;

    const memberIds = [];
    const skipped = [];
    for (const slot of force.slots) {
      const member = slot.userId ? members.get(slot.userId) : null;
      if (!slot.userId) skipped.push({ name: slotLabel(slot), why: "no Discord account" });
      else if (!member) skipped.push({ name: slotLabel(slot), why: "not in the server" });
      else if (!member.roles.cache.has(cfg.verifiedRoleId)) skipped.push({ name: slotLabel(slot), why: "not Verified" });
      else if (claimedUserIds.has(member.id)) skipped.push({ name: slotLabel(slot), why: "already in another force" });
      else {
        claimedUserIds.add(member.id);
        memberIds.push(member.id);
      }
    }

    const leaderIds = cfg.forceLeaderRoleId
      ? memberIds.filter((id) => members.get(id).roles.cache.has(cfg.forceLeaderRoleId))
      : [];
    const leaderId = leaderIds[0] ?? null;

    return {
      name: force.name,
      groups: force.groups,
      channelId: role ? channel.id : null,
      roleId: role?.id ?? null,
      channelProblem,
      leaderId,
      leaderCharName: leaderId ? getStore().getVerification(leaderId)?.char_name ?? null : null,
      otherLeaderIds: leaderIds.slice(1),
      memberIds,
      skipped,
    };
  });

  return {
    compId: String(comp.id ?? ""),
    title: String(comp.title ?? "").trim() || "Untitled comp",
    forces: planned,
    unassigned: unassigned.map(slotLabel),
    clearedChannelIds: voiceChannels.map((channel) => channel.id).filter((id) => !usedChannelIds.has(id)),
  };
}

function keptOverwrites(channel) {
  const botId = channel.guild.members.me.id;
  return channel.permissionOverwrites.cache
    .filter((overwrite) => overwrite.type === OverwriteType.Role || overwrite.id === botId)
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
    }));
}

function hasMemberOverwrites(channel) {
  const botId = channel.guild.members.me.id;
  return channel.permissionOverwrites.cache.some(
    (overwrite) => overwrite.type === OverwriteType.Member && overwrite.id !== botId
  );
}

async function clearMemberOverwrites(voiceChannels, reason, problems) {
  for (const channel of voiceChannels) {
    if (!hasMemberOverwrites(channel)) continue;
    try {
      await channel.permissionOverwrites.set(keptOverwrites(channel), reason);
    } catch (error) {
      problems.push(`${channel.name}: couldn't remove the old member permissions (${error.message})`);
    }
  }
}

async function forceRoleIdsOf(guild, voiceChannels) {
  return new Set([...(await forceRoles(guild, voiceChannels)).values()].map((role) => role.id));
}

async function syncForceRoles(guild, wantedRoleOf, forceRoleIds, reason) {
  const result = { given: 0, removed: 0, problems: [] };
  const members = await guild.members.fetch();
  const currentRolesOf = new Map();
  for (const member of members.values()) {
    const roleIds = [...member.roles.cache.keys()].filter((id) => id !== guild.id);
    if (wantedRoleOf.has(member.id) || roleIds.some((id) => forceRoleIds.has(id))) {
      currentRolesOf.set(member.id, roleIds);
    }
  }

  for (const change of forceRoleChanges(wantedRoleOf, currentRolesOf, forceRoleIds)) {
    const member = members.get(change.memberId);
    if (!member) {
      result.problems.push(`<@${change.memberId}>: left the server`);
      continue;
    }
    const roleIds = currentRolesOf.get(change.memberId).filter((id) => !change.remove.includes(id));
    if (change.add) roleIds.push(change.add);
    try {
      await member.roles.set(roleIds, reason);
      if (change.add) result.given += 1;
      else result.removed += 1;
    } catch (error) {
      result.problems.push(`<@${change.memberId}>: couldn't change their force role (${error.message})`);
    }
  }
  return result;
}

async function applyRoster(guild, plan, actor) {
  return exclusive(async () => {
    const cfg = getConfig();
    const reason = `Roster "${plan.title}" posted by ${actor.tag}`;
    const result = { given: 0, removed: 0, posted: 0, problems: [] };
    const voiceChannels = await forceVoiceChannels(guild);
    const forceRoleIds = await forceRoleIdsOf(guild, voiceChannels);

    const wantedRoleOf = new Map();
    for (const force of plan.forces) {
      if (!force.roleId) continue;
      if (!forceRoleIds.has(force.roleId)) {
        result.problems.push(`${force.name}: its force role is gone`);
        force.roleId = null;
        continue;
      }
      for (const id of force.memberIds) wantedRoleOf.set(id, force.roleId);
    }

    await clearMemberOverwrites(voiceChannels, reason, result.problems);
    const sync = await syncForceRoles(guild, wantedRoleOf, forceRoleIds, reason);
    result.given = sync.given;
    result.removed = sync.removed;
    result.problems.push(...sync.problems);

    let rosterChannel = null;
    try {
      rosterChannel = await guild.channels.fetch(cfg.roster.channelId);
    } catch (error) {
      result.problems.push(`roster channel: ${error.message}`);
    }

    for (const force of plan.forces) {
      if (!rosterChannel || !force.roleId || force.memberIds.length === 0) continue;
      const pinged = force.memberIds.filter((id) => id !== force.leaderId);
      const messages = rosterMessages({
        voiceChannelId: force.channelId,
        leaderId: force.leaderId,
        leaderCharName: force.leaderCharName,
        generalChannelId: cfg.roster.generalChannelId,
        memberIds: pinged,
        divided: result.posted > 0,
      });
      try {
        for (const content of messages) {
          await rosterChannel.send({ content, allowedMentions: { users: force.memberIds } });
        }
        result.posted += 1;
      } catch (error) {
        result.problems.push(`${force.name}: couldn't post the roster (${error.message})`);
      }
    }
    return result;
  });
}

async function resetForceVcs(guild, actor) {
  return exclusive(async () => {
    const reason = `Force voice channels reset by ${actor.tag}`;
    const voiceChannels = await forceVoiceChannels(guild);
    const forceRoleIds = await forceRoleIdsOf(guild, voiceChannels);
    const problems = [];
    await clearMemberOverwrites(voiceChannels, reason, problems);
    const sync = await syncForceRoles(guild, new Map(), forceRoleIds, reason);
    return { removed: sync.removed, roles: forceRoleIds.size, problems: [...problems, ...sync.problems] };
  });
}

async function remindRoster(guild, plan) {
  const cfg = getConfig();
  const result = { posted: 0, pinged: 0, allPresent: [], problems: [] };
  const rosterChannel = await guild.channels.fetch(cfg.roster.channelId);
  const voiceChannelOf = new Map(guild.voiceStates.cache.map((state) => [state.id, state.channelId]));

  for (const force of plan.forces) {
    if (!force.channelId || force.memberIds.length === 0) continue;
    const missing = missingFromVoice(force.memberIds, force.channelId, voiceChannelOf);
    if (missing.length === 0) {
      result.allPresent.push(force.name);
      continue;
    }
    const messages = rosterMessages({
      voiceChannelId: force.channelId,
      leaderId: force.leaderId,
      leaderCharName: force.leaderCharName,
      generalChannelId: cfg.roster.generalChannelId,
      memberIds: missing.filter((id) => id !== force.leaderId),
      divided: result.posted > 0,
      reminder: true,
    });
    try {
      for (const content of messages) {
        await rosterChannel.send({ content, allowedMentions: { users: missing } });
      }
      result.posted += 1;
      result.pinged += missing.length;
    } catch (error) {
      result.problems.push(`${force.name}: couldn't post the reminder (${error.message})`);
    }
  }
  return result;
}

module.exports = { planRoster, applyRoster, resetForceVcs, remindRoster };
