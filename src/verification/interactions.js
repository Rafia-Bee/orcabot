const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { lookupCharacter, lookupEvents, configuredSources, isValidName } = require("./lookup");
const { recordSubmission } = require("./raid");
const { decide, OUTCOMES, DAY_MS } = require("./rules");
const {
  COLORS,
  buildEventEmbed,
  buildSubmissionEmbed,
  postLog,
  postToChannel,
  unixSeconds,
} = require("./embeds");
const { randomGrantDelayMs, startGrantSweeper } = require("./access");
const { watchMee6Tickets } = require("./mee6Tickets");
const { openReviewCase, isReviewButton, handleReviewButton } = require("./review");
const {
  openTicket,
  isTicketButton,
  handleTicketButton,
  isTicketDenyModal,
  handleDenySubmit,
  startArchiveCleanup,
} = require("./tickets");

const CUSTOM_ID_PREFIX = "verify";
const OPEN_BUTTON_ID = "verify:open";
const SUBMIT_MODAL_ID = "verify:submit";
const NAME_INPUT_ID = "character_name";

function buildVerifyPanel() {
  const cfg = getConfig();
  const embed = new EmbedBuilder()
    .setTitle("Faction verification")
    .setColor(0x5865f2)
    .setDescription(
      [
        `This server is for **${cfg.requiredFaction}** on **${cfg.requiredServer}** only.`,
        "",
        "Click **Verify** and enter your in-game character name. " +
          "Our team will confirm your character and unlock the server for you.",
        "",
        `**Requirements:** Level ${cfg.minLevel}+, gear score ${cfg.minGearScore}+.`,
      ].join("\n")
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(OPEN_BUTTON_ID)
      .setLabel("Verify")
      .setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

function buildNameModal() {
  const cfg = getConfig();
  return new ModalBuilder()
    .setCustomId(SUBMIT_MODAL_ID)
    .setTitle("Verify your character")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("In-game character name")
        .setDescription(`Exactly as shown in AION 2 (${cfg.requiredServer})`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(NAME_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(cfg.maxNameLength)
            .setRequired(true)
        )
    );
}

function memberMessage(outcome, reason, name, ticketChannelId, details) {
  const cfg = getConfig();
  const safeName = escapeMarkdown(name);
  if (ticketChannelId) {
    return `Thanks! An officer needs to confirm **${safeName}** before you're verified. Please continue in <#${ticketChannelId}>.`;
  }
  if (reason === "invalid_name") {
    return "That doesn't look like a valid character name. Check it and try again.";
  }
  if (reason === "not_found") {
    return (
      `We couldn't find **${safeName}** on ${cfg.requiredServer}. ` +
      "Check the spelling, including capital letters and special characters, and submit again."
    );
  }
  if (cfg.mode === "live" && outcome === OUTCOMES.DENY) {
    if (reason === "wrong_faction" || reason === "wrong_server") {
      return `**${safeName}** isn't eligible. This server is for ${cfg.requiredFaction} on ${cfg.requiredServer} only.`;
    }
    const reasons = [];
    if (details?.levelTooLow) reasons.push(`Level too low (minimum ${cfg.minLevel})`);
    if (details?.gearScoreTooLow) reasons.push(`Gear score too low (minimum ${cfg.minGearScore})`);
    return `You don't meet the server requirements.\nReason: ${reasons.join(", ")}.`;
  }
  return `Thanks! Your request for **${safeName}** has been received. A moderator will verify you shortly.`;
}

function scheduleVerifiedGrant(interaction, character) {
  const store = getStore();
  try {
    store.saveVerification({
      discordId: interaction.user.id,
      character,
      method: "auto",
    });
  } catch (error) {
    if (error.code === "CHAR_CLAIMED") return { claimedBy: error.claimedBy };
    throw error;
  }
  const dueAt = Date.now() + randomGrantDelayMs();
  store.scheduleGrant({
    discordId: interaction.user.id,
    guildId: interaction.guildId,
    charName: character.name,
    dueAt,
  });
  return { dueAt };
}

async function handleSubmit(interaction) {
  const cfg = getConfig();
  const store = getStore();
  const userId = interaction.user.id;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.member.roles.cache.has(cfg.verifiedRoleId)) {
    return interaction.editReply("You're already verified.");
  }
  const openTicketForUser = store.getOpenTicket(userId);
  if (openTicketForUser) {
    return interaction.editReply(
      `Your request is being reviewed by an officer. Please continue in <#${openTicketForUser.channel_id}>.`
    );
  }
  if (store.getScheduledGrant(userId) || store.getOpenReviewCase(userId)) {
    return interaction.editReply(
      "Your request has already been received. A moderator will verify you shortly."
    );
  }
  const cooldownMs = store.getCooldownRemaining(userId);
  if (cooldownMs > 0) {
    return interaction.editReply(
      `Please wait ${Math.ceil(cooldownMs / 1000)} seconds before trying again.`
    );
  }
  if (recordSubmission(interaction.client)) {
    return interaction.editReply(
      "We're getting a lot of verification requests right now. Please try again in a few minutes."
    );
  }
  store.setCooldown(userId, cfg.submitCooldownSeconds * 1000);

  const submittedName = interaction.fields.getTextInputValue(NAME_INPUT_ID).trim();
  const lookup = await lookupCharacter(submittedName);
  if (lookup.status === "invalid_name") store.setCooldown(userId, 0);
  const character = lookup.status === "found" ? lookup.character : null;
  const accountAgeMs = Date.now() - interaction.user.createdTimestamp;
  const decision = decide({
    lookup,
    accountAgeMs,
    charClaim: character ? store.getVerificationForCharacter(character) : null,
    ownClaim: store.getVerification(userId),
    discordId: userId,
    config: cfg,
  });
  const displayName = character ? character.name : submittedName;

  let outcome = decision.outcome;
  let reason = decision.reason;
  const logFields = [];
  let ticketChannelId = null;

  if (cfg.mode === "live") {
    if (outcome === OUTCOMES.VERIFY) {
      const grant = scheduleVerifiedGrant(interaction, character);
      if (grant.claimedBy) {
        outcome = OUTCOMES.REVIEW;
        reason = "name_already_claimed";
        decision.details = { claimedBy: grant.claimedBy };
      } else {
        logFields.push({
          name: "Role granted",
          value: `<t:${unixSeconds(grant.dueAt)}:R>`,
          inline: true,
        });
      }
    }

    if (outcome === OUTCOMES.TICKET) {
      try {
        const ticket = await openTicket(interaction, { character, reason });
        ticketChannelId = ticket.channel_id;
        logFields.push({ name: "Ticket", value: `<#${ticket.channel_id}> (#${ticket.id})`, inline: true });
      } catch (error) {
        console.error("Failed to open verification ticket:", error);
        outcome = OUTCOMES.REVIEW;
        logFields.push({ name: "Ticket failed", value: error.message.slice(0, 1000) });
      }
    }

    if (outcome === OUTCOMES.REVIEW) {
      const reviewCase = await openReviewCase(interaction.client, {
        discordId: userId,
        charName: displayName,
        reason,
        character,
        context: {
          accountAgeDays: Math.floor(accountAgeMs / DAY_MS),
          lookupError: lookup.status === "unavailable" ? lookup.reason : null,
          details: decision.details,
        },
      });
      logFields.push({ name: "Review case", value: `#${reviewCase.id}`, inline: true });
    }
  }

  const logEmbed = buildSubmissionEmbed({
    user: interaction.user,
    submittedName,
    lookup,
    decision: { ...decision, reason },
    outcome,
    accountAgeMs,
  });
  if (logFields.length) logEmbed.addFields(logFields);
  if (ticketChannelId) {
    await postToChannel(interaction.client, cfg.reviewChannelId, { embeds: [logEmbed] });
  } else {
    await postLog(interaction.client, logEmbed);
  }

  return interaction.editReply(memberMessage(outcome, reason, displayName, ticketChannelId, decision.details));
}

async function handleComponent(interaction) {
  if (interaction.isButton() && interaction.customId === OPEN_BUTTON_ID) {
    return interaction.showModal(buildNameModal());
  }
  if (interaction.isModalSubmit() && interaction.customId === SUBMIT_MODAL_ID) {
    return handleSubmit(interaction);
  }
  if (interaction.isModalSubmit() && isTicketDenyModal(interaction.customId)) {
    return handleDenySubmit(interaction);
  }
  if (interaction.isButton() && isTicketButton(interaction.customId)) {
    return handleTicketButton(interaction);
  }
  if (interaction.isButton() && isReviewButton(interaction.customId)) {
    return handleReviewButton(interaction);
  }
}

const COOLDOWN_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const SOURCE_SETTINGS = {
  shugo: { required: ["equipment"], settings: "SHUGO_BASE_URL and SHUGO_REGION_PATH" },
  aion2index: { required: ["characterId"], settings: "AION2INDEX_BASE_URL and AION2INDEX_REGION_PATH" },
};

function sourceProblem(source, name, lookup) {
  const cfg = getConfig();
  const { required, settings } = SOURCE_SETTINGS[source.name];
  if (lookup.status === "invalid_name") {
    return `SHUGO_HEALTHCHECK_CHARACTER ("${name}") isn't a valid character name.`;
  }
  if (lookup.status === "not_found") {
    return (
      `**${escapeMarkdown(name)}** wasn't found. If the character was renamed or deleted, ` +
      `set SHUGO_HEALTHCHECK_CHARACTER to another one. Otherwise check ${settings}.`
    );
  }
  if (lookup.status !== "found") {
    return `The lookup failed: ${lookup.reason}.`;
  }
  const c = lookup.character;
  const missing = ["name", "level", "faction", "server", "gearScore", ...required].filter((key) =>
    key === "equipment" ? Object.keys(c.equipment ?? {}).length === 0 : c[key] == null
  );
  if (missing.length) {
    return `The lookup worked but is missing: ${missing.join(", ")}. ${source.label} may have changed its data.`;
  }
  if (c.faction !== cfg.requiredFaction || c.server !== cfg.requiredServer) {
    return (
      `**${escapeMarkdown(c.name)}** shows as ${c.faction} on ${c.server}, but the bot requires ` +
      `${cfg.requiredFaction} on ${cfg.requiredServer}. Check REQUIRED_FACTION, REQUIRED_SERVER and ${settings}.`
    );
  }
  return null;
}

async function checkLookupSources(client) {
  const name = getConfig().lookup.healthcheckCharacter;
  if (!name) {
    console.warn("SHUGO_HEALTHCHECK_CHARACTER isn't set, skipping the startup lookup check");
    return;
  }

  const problems = [];
  for (const source of configuredSources()) {
    const lookup = isValidName(name) ? await source.lookup(name) : { status: "invalid_name" };
    const problem = sourceProblem(source, name, lookup);
    if (problem) {
      console.warn(`${source.label} check failed: ${problem}`);
      problems.push({ name: source.label, value: problem.slice(0, 1024) });
    } else {
      const c = lookup.character;
      console.log(`${source.label} check OK: ${c.name}, level ${c.level}, gear score ${c.gearScore}`);
    }
  }
  if (problems.length === 0) return;

  await postLog(
    client,
    buildEventEmbed({
      color: COLORS.red,
      title: "Character lookup check failed on startup",
      description:
        "Until this is fixed, verification may not work correctly, or may rely on the backup site. " +
        "Check a few new submissions in the log channel.",
      fields: problems,
    })
  );
}

function watchLookupSources(client) {
  const post = (color, title, description) =>
    postLog(client, buildEventEmbed({ color, title, description }));
  lookupEvents.on("down", ({ source, reason }) =>
    post(
      COLORS.yellow,
      `${source} isn't answering`,
      `Lookups use the next site in LOOKUP_SOURCES for ${getConfig().lookup.failoverMinutes} min, ` +
        `then ${source} is tried again.\nReason: ${reason}`
    )
  );
  lookupEvents.on("up", ({ source }) => post(COLORS.green, `${source} is answering again`, "Lookups are back to normal."));
  lookupEvents.on("auth_failed", ({ source, reason }) =>
    post(
      COLORS.red,
      `${source} rejected the API key`,
      `${reason}. Check AION2INDEX_API_KEY in .env, or replace the key in your aion2index panel.`
    )
  );
}

function startCooldownPruning() {
  const prune = () => {
    try {
      getStore().pruneCooldowns();
    } catch (error) {
      console.error("Cooldown pruning error:", error);
    }
  };
  prune();
  return setInterval(prune, COOLDOWN_PRUNE_INTERVAL_MS);
}

function onReady(client) {
  const cfg = getConfig();
  console.log(`Verification mode: ${cfg.mode}`);
  console.log(
    cfg.legionRoles.length || cfg.guestRoleId
      ? `Legion roles: ${cfg.legionRoles.map((l) => l.name).join(", ")}${cfg.guestRoleId ? ", Guest for everyone else" : ""}`
      : "Legion roles: off (LEGION_ROLES and GUEST_ROLE_ID not set)"
  );
  console.log(
    cfg.classRoles.length
      ? `Class roles: ${cfg.classRoles.map((c) => c.name).join(", ")}`
      : "Class roles: off (CLASS_ROLES not set)"
  );
  startGrantSweeper(client);
  startArchiveCleanup(client);
  startCooldownPruning();
  watchMee6Tickets(client);
  watchLookupSources(client);
  console.log(`Character lookups: ${cfg.lookup.sources.join(" → ")}`);
  checkLookupSources(client).catch((error) => console.error("Lookup check error:", error));
}

module.exports = {
  CUSTOM_ID_PREFIX,
  OPEN_BUTTON_ID,
  buildVerifyPanel,
  handleComponent,
  onReady,
};
