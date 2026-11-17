// /settings: lets server admins pick the bot's channels, categories and roles from Discord's own pickers.
//   isAdmin          true when the member has Manage Server
//   guildChecks      what findProblems needs to know about the server (does a role or channel exist, can the bot give a role)
//   mainView         the overview: every setting, what's missing, problems, and a list to pick one to change
//   editView         one setting's screen: a role or channel picker, Clear and Back
//   roleMapView      the legion or class role list's screen: Add, Remove one, Back
//   addEntryModal    the pop-up for adding a legion or class with its role
//   save             saves a setting, refreshes the config and logs the change in the background
//   handleComponent  handles every button, list and pop-up on these screens

const {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  SETTINGS,
  settingByKey,
  isEmpty,
  missingRequired,
  findProblems,
  describeValue,
  addRoleMapEntry,
  removeRoleMapEntry,
} = require("../settings/ids");
const { getStore } = require("../verification/store");
const { clearConfigCache } = require("../verification/config");
const { COLORS, buildEventEmbed, postLog } = require("../verification/embeds");

const PREFIX = "settings";
const id = (...parts) => [PREFIX, ...parts].join(":");

const CHANNEL_TYPES = {
  channel: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  category: [ChannelType.GuildCategory],
  ticketParents: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory],
};

function isAdmin(member) {
  return member?.permissions.has(PermissionsBitField.Flags.ManageGuild) ?? false;
}

function guildChecks(guild) {
  const botTop = guild.members.me?.roles.highest.position ?? 0;
  return {
    hasRole: (roleId) => guild.roles.cache.has(roleId),
    hasChannel: (channelId) => guild.channels.cache.has(channelId),
    canGiveRole: (roleId) => (guild.roles.cache.get(roleId)?.position ?? Infinity) < botTop,
  };
}

function backButton() {
  return new ButtonBuilder().setCustomId(id("back")).setLabel("Back").setStyle(ButtonStyle.Secondary);
}

function mainView(guild, note = "") {
  const values = getStore().getServerSettings();
  const missing = missingRequired(values);
  const problems = findProblems(values, guildChecks(guild));
  const lines = [
    note,
    "Pick a setting from the list below to change it.",
    missing.length ? `**Missing:** ${missing.map((s) => s.label).join(", ")}` : "",
    problems.length ? `**Problems:**\n${problems.map((p) => `- ${p}`).join("\n")}` : "",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(missing.length || problems.length ? COLORS.yellow : COLORS.blue)
    .setTitle("Server settings")
    .setDescription(lines.join("\n\n"))
    .addFields(
      SETTINGS.map((setting) => ({
        name: setting.required ? setting.label : `${setting.label} (optional)`,
        value: describeValue(setting, values[setting.key]).slice(0, 1024),
        inline: setting.kind !== "roleMap",
      }))
    );

  const picker = new StringSelectMenuBuilder()
    .setCustomId(id("pick"))
    .setPlaceholder("Change a setting")
    .addOptions(
      SETTINGS.map((setting) => ({
        label: setting.label,
        value: setting.key,
        description: setting.help.slice(0, 100),
      }))
    );

  return { content: "", embeds: [embed], components: [new ActionRowBuilder().addComponents(picker)] };
}

function editView(setting) {
  const value = getStore().getServerSettings()[setting.key];
  const embed = new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle(setting.label)
    .setDescription(`${setting.help}\n\n**Now:** ${describeValue(setting, value)}`);

  let picker;
  if (setting.kind === "role") {
    picker = new RoleSelectMenuBuilder().setCustomId(id("set", setting.key)).setPlaceholder("Pick a role");
    if (value) picker.setDefaultRoles(value);
  } else {
    const multiple = setting.kind === "ticketParents";
    picker = new ChannelSelectMenuBuilder()
      .setCustomId(id("set", setting.key))
      .setChannelTypes(...CHANNEL_TYPES[setting.kind])
      .setPlaceholder(setting.kind === "category" ? "Pick a category" : multiple ? "Pick channels or categories" : "Pick a channel")
      .setMinValues(1)
      .setMaxValues(multiple ? 10 : 1);
    if (!isEmpty(value)) picker.setDefaultChannels(...(Array.isArray(value) ? value : [value]));
  }

  const clear = new ButtonBuilder()
    .setCustomId(id("clear", setting.key))
    .setLabel("Clear")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(Boolean(setting.required) || isEmpty(value));

  return {
    content: "",
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(picker),
      new ActionRowBuilder().addComponents(clear, backButton()),
    ],
  };
}

function roleMapView(setting) {
  const list = getStore().getServerSettings()[setting.key] ?? [];
  const embed = new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle(setting.label)
    .setDescription(`${setting.help}\n\n${describeValue(setting, list)}`.slice(0, 4096));

  const rows = [];
  if (list.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(id("remove", setting.key))
          .setPlaceholder(`Remove a ${setting.entryName.toLowerCase()}`)
          .addOptions(list.slice(0, 25).map((entry) => ({ label: entry.name, value: entry.name })))
      )
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(id("add", setting.key))
        .setLabel(`Add or change a ${setting.entryName.toLowerCase()}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(list.length >= 25),
      backButton()
    )
  );
  return { content: "", embeds: [embed], components: rows };
}

function addEntryModal(setting) {
  const name = new TextInputBuilder()
    .setCustomId("name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);
  const role = new RoleSelectMenuBuilder().setCustomId("role").setRequired(true);
  return new ModalBuilder()
    .setCustomId(id("addsave", setting.key))
    .setTitle(`Add a ${setting.entryName.toLowerCase()}`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`${setting.entryName} name`)
        .setDescription("As the game spells it. Capitals don't matter. An existing name gets the new role.")
        .setTextInputComponent(name),
      new LabelBuilder().setLabel("Role").setRoleSelectMenuComponent(role)
    );
}

function save(interaction, setting, value) {
  const before = getStore().getServerSettings()[setting.key];
  getStore().setServerSetting(setting.key, isEmpty(value) ? null : value, interaction.user.id);
  clearConfigCache();
  postLog(
    interaction.client,
    buildEventEmbed({
      color: COLORS.blue,
      title: "Setting changed",
      description:
        `**${setting.label}** changed by ${interaction.user}\n` +
        `**Before:** ${describeValue(setting, before)}\n**Now:** ${describeValue(setting, value)}`,
    })
  );
}

function viewFor(setting) {
  return setting.kind === "roleMap" ? roleMapView(setting) : editView(setting);
}

async function handleComponent(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Only server admins can change settings.", flags: MessageFlags.Ephemeral });
  }
  const [, action, key] = interaction.customId.split(":");
  const setting = key ? settingByKey(key) : null;
  if (key && !setting) return interaction.update(mainView(interaction.guild));

  if (action === "back") return interaction.update(mainView(interaction.guild));
  if (action === "pick") return interaction.update(viewFor(settingByKey(interaction.values[0])));
  if (action === "add") return interaction.showModal(addEntryModal(setting));

  if (action === "set") {
    const value = setting.kind === "ticketParents" ? interaction.values : interaction.values[0];
    save(interaction, setting, value);
    return interaction.update(mainView(interaction.guild, `Saved **${setting.label}**.`));
  }
  if (action === "clear") {
    save(interaction, setting, null);
    return interaction.update(mainView(interaction.guild, `Cleared **${setting.label}**.`));
  }
  if (action === "remove") {
    const list = getStore().getServerSettings()[setting.key] ?? [];
    save(interaction, setting, removeRoleMapEntry(list, interaction.values[0]));
    return interaction.update(roleMapView(setting));
  }
  if (action === "addsave") {
    const roleId = interaction.fields.getSelectedRoles("role")?.first()?.id;
    const list = getStore().getServerSettings()[setting.key] ?? [];
    let updated;
    try {
      updated = addRoleMapEntry(list, interaction.fields.getTextInputValue("name"), roleId);
    } catch (error) {
      return interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
    }
    save(interaction, setting, updated);
    return interaction.update(roleMapView(setting));
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Pick the channels, categories and roles the bot uses")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  customIdPrefix: PREFIX,
  handleComponent,
  async execute(interaction) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: "Only server admins can change settings.", flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ ...mainView(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};
