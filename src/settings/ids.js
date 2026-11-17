// The server's channels, categories and roles that admins pick with /settings, and the rules around them.
//   SETTINGS          every setting: its old .env name, label, kind, and whether it's required
//   settingByKey      finds a setting by its key
//   parseRoleMap      reads a "Name:roleId,Name:roleId" list (the old .env format)
//   importsFromEnv    the settings found in the old .env lines, ready to copy into the database
//   isEmpty           true when a setting has no value
//   missingRequired   the required settings that aren't set
//   toConfigFields    turns saved values into the fields the rest of the bot reads from getConfig()
//   findProblems      deleted roles or channels, and roles the bot can't give out
//   describeValue     a setting's value as Discord mentions, or "not set"
//   addRoleMapEntry   adds or replaces a name in a legion or class role list
//   removeRoleMapEntry removes a name from a legion or class role list

const SETTINGS = [
  { key: "VERIFIED_ROLE_ID", label: "Verified role", kind: "role", required: true, given: true, help: "The role that unlocks the server." },
  { key: "OFFICERS_ROLE_ID", label: "Officers role", kind: "role", required: true, help: "Handles review tickets." },
  { key: "MODERATOR_ROLE_ID", label: "Moderator role", kind: "role", help: "A second staff role that can also handle tickets and the review channel." },
  { key: "GUEST_ROLE_ID", label: "Guest role", kind: "role", given: true, help: "Given to verified members who aren't in one of the legions below." },
  { key: "LEGION_ROLES", label: "Legion roles", kind: "roleMap", given: true, entryName: "Legion", help: "Each alliance legion and the role its members get. Names must match the game." },
  { key: "CLASS_ROLES", label: "Class roles", kind: "roleMap", given: true, entryName: "Class", help: "Each class and its role: Gladiator, Templar, Assassin, Ranger, Sorcerer, Spiritmaster, Cleric, Chanter." },
  { key: "FORCE_LEADER_ROLE_ID", label: "Force Leader role", kind: "role", help: "Gives the FL nickname. /announce-roster and /create-timeslots use it." },
  { key: "VERIFY_CHANNEL_ID", label: "Verify channel", kind: "channel", required: true, help: "Where new members click Verify. Run /refresh-verify-channel after changing it." },
  { key: "VERIFY_LOG_CHANNEL_ID", label: "Log channel", kind: "channel", required: true, help: "Mods-only log of everything the bot does." },
  { key: "VERIFY_REVIEW_CHANNEL_ID", label: "Review channel", kind: "channel", required: true, help: "Mods-only channel for cases that need a person to look." },
  { key: "REVIEW_TICKETS_CATEGORY_ID", label: "Tickets category", kind: "category", required: true, help: "Where open review tickets go." },
  { key: "ARCHIVED_REVIEW_TICKETS_CATEGORY_ID", label: "Archive category", kind: "category", required: true, help: "Where closed tickets are moved." },
  { key: "MEE6_TICKET_PARENT_IDS", label: "MEE6 ticket places", kind: "ticketParents", help: "The channel MEE6 opens ticket threads in, or the category its ticket channels go in. Takes effect after a restart." },
  { key: "FORCE_VC_CATEGORY_ID", label: "Force voice category", kind: "category", help: "The category with the force voice channels." },
  { key: "ROSTER_CHANNEL_ID", label: "Roster channel", kind: "channel", help: "Where /announce-roster posts each force's pings." },
  { key: "ROSTER_GENERAL_CHANNEL_ID", label: "General channel", kind: "channel", help: "Where members are told to ping their Force Leader when they can't make it." },
];

const ID = /^\d+$/;

function settingByKey(key) {
  return SETTINGS.find((setting) => setting.key === key) ?? null;
}

function parseRoleMap(raw, settingName) {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      const name = entry.slice(0, separator).trim();
      const roleId = entry.slice(separator + 1).trim();
      if (separator < 1 || !name || !ID.test(roleId)) {
        throw new Error(`${settingName} entry "${entry}" must look like Name:roleId`);
      }
      return { name, roleId };
    });
}

function valueFromEnv(setting, raw) {
  const text = raw?.trim();
  if (!text) return null;
  if (setting.kind === "roleMap") {
    try {
      return parseRoleMap(text, setting.key);
    } catch {
      return null;
    }
  }
  if (setting.kind === "ticketParents") {
    const ids = text.split(",").map((id) => id.trim()).filter(Boolean);
    return ids.length && ids.every((id) => ID.test(id)) ? ids : null;
  }
  return ID.test(text) ? text : null;
}

function importsFromEnv(env) {
  return SETTINGS.map((setting) => ({ key: setting.key, value: valueFromEnv(setting, env[setting.key]) })).filter(
    ({ value }) => !isEmpty(value)
  );
}

function isEmpty(value) {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function missingRequired(values) {
  return SETTINGS.filter((setting) => setting.required && isEmpty(values[setting.key]));
}

function toConfigFields(values) {
  const one = (key) => (isEmpty(values[key]) ? null : values[key]);
  const list = (key) => (isEmpty(values[key]) ? [] : values[key]);
  return {
    verifiedRoleId: one("VERIFIED_ROLE_ID"),
    verifyChannelId: one("VERIFY_CHANNEL_ID"),
    logChannelId: one("VERIFY_LOG_CHANNEL_ID"),
    reviewChannelId: one("VERIFY_REVIEW_CHANNEL_ID"),
    officersRoleId: one("OFFICERS_ROLE_ID"),
    moderatorRoleId: one("MODERATOR_ROLE_ID"),
    ticketsCategoryId: one("REVIEW_TICKETS_CATEGORY_ID"),
    archivedTicketsCategoryId: one("ARCHIVED_REVIEW_TICKETS_CATEGORY_ID"),
    legionRoles: list("LEGION_ROLES"),
    guestRoleId: one("GUEST_ROLE_ID"),
    classRoles: list("CLASS_ROLES"),
    forceLeaderRoleId: one("FORCE_LEADER_ROLE_ID"),
    mee6TicketParentIds: list("MEE6_TICKET_PARENT_IDS"),
    roster: {
      forceVcCategoryId: one("FORCE_VC_CATEGORY_ID"),
      channelId: one("ROSTER_CHANNEL_ID"),
      generalChannelId: one("ROSTER_GENERAL_CHANNEL_ID"),
    },
  };
}

function findProblems(values, guild) {
  const problems = [];
  for (const setting of SETTINGS) {
    const value = values[setting.key];
    if (isEmpty(value)) continue;
    if (setting.kind === "role") {
      if (!guild.hasRole(value)) problems.push(`${setting.label}: the role was deleted.`);
      else if (setting.given && !guild.canGiveRole(value)) {
        problems.push(`${setting.label}: the bot's own role must be above this role to give it out.`);
      }
    } else if (setting.kind === "roleMap") {
      for (const { name, roleId } of value) {
        if (!guild.hasRole(roleId)) problems.push(`${setting.label}: the role for ${name} was deleted.`);
        else if (!guild.canGiveRole(roleId)) {
          problems.push(`${setting.label}: the bot's own role must be above the role for ${name} to give it out.`);
        }
      }
    } else {
      const ids = Array.isArray(value) ? value : [value];
      if (ids.some((id) => !guild.hasChannel(id))) problems.push(`${setting.label}: the channel or category was deleted.`);
    }
  }
  return problems;
}

function describeValue(setting, value) {
  if (isEmpty(value)) return "not set";
  if (setting.kind === "role") return `<@&${value}>`;
  if (setting.kind === "roleMap") return value.map(({ name, roleId }) => `${name} → <@&${roleId}>`).join("\n");
  const ids = Array.isArray(value) ? value : [value];
  return ids.map((id) => `<#${id}>`).join(", ");
}

function addRoleMapEntry(list, rawName, roleId) {
  const name = rawName.trim();
  if (!name || name.includes(":") || name.includes(",") || name.length > 50) {
    throw new Error("The name can't be empty, longer than 50 letters, or contain : or ,");
  }
  const lower = name.toLowerCase();
  const kept = list.filter((entry) => entry.name.toLowerCase() !== lower);
  const index = list.findIndex((entry) => entry.name.toLowerCase() === lower);
  const entry = { name, roleId };
  if (index === -1) return [...kept, entry];
  return [...kept.slice(0, index), entry, ...kept.slice(index)];
}

function removeRoleMapEntry(list, name) {
  const lower = name.trim().toLowerCase();
  return list.filter((entry) => entry.name.toLowerCase() !== lower);
}

module.exports = {
  SETTINGS,
  settingByKey,
  parseRoleMap,
  importsFromEnv,
  isEmpty,
  missingRequired,
  toConfigFields,
  findProblems,
  describeValue,
  addRoleMapEntry,
  removeRoleMapEntry,
};
