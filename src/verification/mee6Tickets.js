const { ChannelType, OverwriteType, PermissionFlagsBits } = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { buildClaimEmbed, buildNoClaimEmbed } = require("./embeds");
const { isStaff } = require("./tickets");

const SETTLE_DELAY_MS = 3000;
const MAX_LOOKUPS = 3;
const TOPIC_CHECK_ATTEMPTS = 5;
const TOPIC_CHECK_GAP_MS = 2000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForTopic(channel) {
  for (let attempt = 0; attempt < TOPIC_CHECK_ATTEMPTS; attempt++) {
    if (channel.topic) return channel;
    await wait(TOPIC_CHECK_GAP_MS);
    channel = await channel.fetch(true);
  }
  return channel;
}

function topicOpenerIds(topic) {
  const createdBy = topic?.split(/created by:/i)[1] ?? "";
  return [...createdBy.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]);
}

async function renameTicket(channel, renames) {
  const topic = channel.topic?.toLowerCase() ?? "";
  const match = renames.find((rename) => topic.includes(rename.phrase.toLowerCase()));
  if (!match) {
    console.warn(
      `MEE6 ticket ${channel.name}: no ticket type phrase in topic "${channel.topic ?? ""}", name left as is`
    );
    return;
  }
  const separator = channel.name.indexOf("-");
  const rest = separator === -1 ? channel.name : channel.name.slice(separator + 1);
  const name = `${match.prefix}-${rest}`;
  if (name !== channel.name) await channel.setName(name, `MEE6 ticket type: ${match.phrase}`);
}

function watchMee6Tickets(client) {
  const { mee6TicketParentIds: parentIds, mee6TicketRenames: renames } = getConfig();
  if (parentIds.length === 0) {
    console.log("MEE6 ticket lookups: off (MEE6_TICKET_PARENT_IDS not set)");
    return;
  }
  console.log(`MEE6 ticket lookups: watching ${parentIds.join(", ")}`);
  if (renames.length > 0) {
    console.log(`MEE6 ticket renames: ${renames.map((r) => `${r.phrase} -> ${r.prefix}-`).join(", ")}`);
  }

  client.on("threadCreate", async (thread, newlyCreated) => {
    if (!newlyCreated || !parentIds.includes(thread.parentId)) return;
    try {
      await wait(SETTLE_DELAY_MS);
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
    await wait(SETTLE_DELAY_MS);
    const fresh = await channel
      .fetch(true)
      .then(waitForTopic)
      .catch(() => null);
    if (!fresh) return;
    const fromTopic = topicOpenerIds(fresh.topic);
    await Promise.all([
      postLookups(fresh, fromTopic.length > 0 ? fromTopic : channelMemberIds(fresh)).catch((error) =>
        console.error(`MEE6 ticket lookup error in channel ${channel.id}:`, error)
      ),
      renames.length > 0 &&
        renameTicket(fresh, renames).catch((error) =>
          console.error(`MEE6 ticket rename error in channel ${channel.id}:`, error)
        ),
    ]);
  });
}

module.exports = { watchMee6Tickets };
