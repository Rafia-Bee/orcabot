const { escapeMarkdown } = require("discord.js");

const RAID_HELPER_API_BASE = "https://raid-helper.xyz/api/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_LENGTH = 2000;

function parseRaidHelperId(input) {
  const ids = String(input ?? "").match(/\d{15,22}/g);
  return ids ? ids[ids.length - 1] : null;
}

function fetchComp(compId, options) {
  return fetchRaidHelper(`comps/${compId}`, options);
}

function fetchEvent(eventId, options) {
  return fetchRaidHelper(`events/${eventId}`, options);
}

async function fetchRaidHelper(path, { apiKey = null, userAgent = null } = {}) {
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = apiKey;
  if (userAgent) headers["User-Agent"] = userAgent;

  let response;
  try {
    response = await fetch(`${RAID_HELPER_API_BASE}/${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`raid-helper didn't answer (${error.message})`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.status === "failed") {
    throw new Error(
      body?.reason ? `raid-helper says: ${body.reason}` : `raid-helper answered with HTTP ${response.status}`
    );
  }
  return body;
}

function byPosition(a, b) {
  return a.position - b.position;
}

function buildForces(comp) {
  const dividers = [...(comp.dividers ?? [])].sort(byPosition);
  const groups = [...(comp.groups ?? [])].sort(byPosition);

  const forces = dividers.map((divider) => ({ name: String(divider.name ?? "").trim(), groups: [], slots: [] }));
  const forceOfGroup = new Map();
  groups.forEach((group, i) => {
    const groupNumber = i + 1;
    const index = dividers.findLastIndex((divider) => divider.position < group.position);
    if (index < 0) return;
    forces[index].groups.push(groupNumber);
    forceOfGroup.set(groupNumber, index);
  });

  const unassigned = [];
  const slots = [...(comp.slots ?? [])].sort(
    (a, b) => a.groupNumber - b.groupNumber || a.slotNumber - b.slotNumber
  );
  for (const slot of slots) {
    const index = forceOfGroup.get(slot.groupNumber);
    if (index === undefined) unassigned.push(slot);
    else forces[index].slots.push(slot);
  }
  return { forces, unassigned };
}

function channelKey(name) {
  return String(name ?? "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function rosterMessages({ voiceChannelId, leaderId, leaderCharName, generalChannelId, memberIds }) {
  const leader = leaderId ? `<@${leaderId}>` : "your force leader";
  const whisper = leaderId && leaderCharName ? `${leader} (**${escapeMarkdown(leaderCharName)}**)` : leader;
  const general = generalChannelId ? `<#${generalChannelId}>` : "#general";
  const head =
    `Join <#${voiceChannelId}> and whisper ${whisper} in game to get invited to your force. ` +
    `If you can't make it, please ping ${leader} to let them know in ${general}.`;

  const messages = [];
  let current = head;
  for (const mention of memberIds.map((id) => `<@${id}>`)) {
    const separator = current === head ? "\n" : " ";
    if (current.length + separator.length + mention.length > MAX_MESSAGE_LENGTH) {
      messages.push(current);
      current = mention;
    } else {
      current += separator + mention;
    }
  }
  messages.push(current);
  return messages;
}

module.exports = { parseRaidHelperId, fetchComp, fetchEvent, buildForces, channelKey, rosterMessages };
