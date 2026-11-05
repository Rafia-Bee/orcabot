const { ChannelType, OverwriteType, PermissionFlagsBits } = require("discord.js");
const { getConfig } = require("../verification/config");
const { getStore } = require("../verification/store");
const { buildForces, channelKey, missingFromVoice, rosterMessages } = require("./comp");

const MEMBER_FETCH_BATCH = 100;
const FORCE_MEMBER_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];

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
      channelId: channel && !channelTaken ? channel.id : null,
      channelProblem: channelTaken ? "its voice channel is already used by another force" : channel ? null : "no voice channel with this name",
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

async function setForceMembers(channel, memberIds, reason) {
  const overwrites = [
    ...keptOverwrites(channel),
    ...memberIds.map((id) => ({ id, type: OverwriteType.Member, allow: FORCE_MEMBER_ALLOW })),
  ];
  return channel.permissionOverwrites.set(overwrites, reason);
}

async function applyRoster(guild, plan, actor) {
  return exclusive(async () => {
    const cfg = getConfig();
    const reason = `Roster "${plan.title}" posted by ${actor.tag}`;
    const result = { updated: 0, cleared: 0, posted: 0, problems: [] };
    const voiceChannels = new Map((await forceVoiceChannels(guild)).map((channel) => [channel.id, channel]));

    const targets = [
      ...plan.forces.filter((force) => force.channelId).map((force) => ({ channelId: force.channelId, force })),
      ...plan.clearedChannelIds.map((channelId) => ({ channelId, force: null })),
    ];
    for (const { channelId, force } of targets) {
      const channel = voiceChannels.get(channelId);
      if (!channel) {
        result.problems.push(`${force?.name ?? channelId}: the voice channel is gone`);
        continue;
      }
      if (!force && !hasMemberOverwrites(channel)) continue;
      try {
        await setForceMembers(channel, force?.memberIds ?? [], reason);
        if (force) result.updated += 1;
        else result.cleared += 1;
      } catch (error) {
        result.problems.push(`${channel.name}: couldn't change permissions (${error.message})`);
        if (force) force.failed = true;
      }
    }

    let rosterChannel = null;
    try {
      rosterChannel = await guild.channels.fetch(cfg.roster.channelId);
    } catch (error) {
      result.problems.push(`roster channel: ${error.message}`);
    }

    for (const force of plan.forces) {
      if (!rosterChannel || !force.channelId || force.failed || force.memberIds.length === 0) continue;
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
    const result = { reset: 0, removed: 0, problems: [] };
    for (const channel of await forceVoiceChannels(guild)) {
      if (!hasMemberOverwrites(channel)) continue;
      const botId = guild.members.me.id;
      const removed = channel.permissionOverwrites.cache.filter(
        (overwrite) => overwrite.type === OverwriteType.Member && overwrite.id !== botId
      ).size;
      try {
        await channel.permissionOverwrites.set(keptOverwrites(channel), reason);
        result.reset += 1;
        result.removed += removed;
      } catch (error) {
        result.problems.push(`${channel.name}: ${error.message}`);
      }
    }
    return result;
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
