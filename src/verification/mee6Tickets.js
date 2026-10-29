const { ChannelType, OverwriteType, PermissionFlagsBits } = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { buildClaimEmbed, buildNoClaimEmbed } = require("./embeds");
const { isStaff } = require("./tickets");

const SETTLE_DELAY_MS = 3000;
const MAX_LOOKUPS = 3;

function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
}

async function threadMemberIds(thread) {
  if (!thread.joined) await thread.join().catch(() => {});
  const members = await thread.members.fetch();
  return [...members.keys()];
}

function channelMemberIds(channel) {
  return channel.permissionOverwrites.cache
    .filter(
      (overwrite) =>
        overwrite.type === OverwriteType.Member &&
        overwrite.allow.has(PermissionFlagsBits.ViewChannel)
    )
    .map((overwrite) => overwrite.id);
}

async function findOpeners(guild, ids) {
  const members = [];
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && !member.user.bot) members.push(member);
  }
  const nonStaff = members.filter((member) => !isStaff(member));
  return (nonStaff.length > 0 ? nonStaff : members).slice(0, MAX_LOOKUPS);
}

async function postLookups(channel, ids) {
  const openers = await findOpeners(channel.guild, ids);
  if (openers.length === 0) {
    console.warn(`MEE6 ticket ${channel.id}: couldn't tell who opened it`);
    return;
  }
  const store = getStore();
  const embeds = openers.map((member) => {
    const claim = store.getVerification(member.id);
    return claim ? buildClaimEmbed(claim, member) : buildNoClaimEmbed(member);
  });
  await channel.send({ embeds, allowedMentions: { parse: [] } });
}

function watchMee6Tickets(client) {
  const parentIds = getConfig().mee6TicketParentIds;
  if (parentIds.length === 0) {
    console.log("MEE6 ticket lookups: off (MEE6_TICKET_PARENT_IDS not set)");
    return;
  }
  console.log(`MEE6 ticket lookups: watching ${parentIds.join(", ")}`);

  client.on("threadCreate", async (thread, newlyCreated) => {
    if (!newlyCreated || !parentIds.includes(thread.parentId)) return;
    try {
      await settle();
      await postLookups(thread, await threadMemberIds(thread));
    } catch (error) {
      console.error(`MEE6 ticket lookup error in thread ${thread.id}:`, error);
    }
  });

  client.on("channelCreate", async (channel) => {
    if (
      channel.type !== ChannelType.GuildText ||
      !parentIds.includes(channel.parentId) ||
      channel.name.startsWith("verify-")
    ) {
      return;
    }
    try {
      await settle();
      const fresh = await channel.fetch(true);
      await postLookups(fresh, channelMemberIds(fresh));
    } catch (error) {
      console.error(`MEE6 ticket lookup error in channel ${channel.id}:`, error);
    }
  });
}

module.exports = { watchMee6Tickets };
