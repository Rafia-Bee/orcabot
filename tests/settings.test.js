const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SETTINGS,
  settingByKey,
  importsFromEnv,
  missingRequired,
  toConfigFields,
  findProblems,
  describeValue,
  addRoleMapEntry,
  removeRoleMapEntry,
} = require("../src/settings/ids");
const { openStore } = require("../src/verification/store");

test("every setting has a unique key, a label and a known kind", () => {
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const setting of SETTINGS) {
    assert.ok(setting.label, setting.key);
    assert.ok(["role", "channel", "category", "ticketParents", "roleMap"].includes(setting.kind), setting.key);
  }
  assert.ok(SETTINGS.length <= 25, "the setting picker holds at most 25 options");
});

test("importsFromEnv reads the old .env lines", () => {
  const env = {
    VERIFIED_ROLE_ID: " 111 ",
    VERIFY_CHANNEL_ID: "222",
    MODERATOR_ROLE_ID: "",
    LEGION_ROLES: "Aegis:333, SDC:444",
    MEE6_TICKET_PARENT_IDS: "555, 666",
    BOT_TOKEN: "secret",
  };
  assert.deepEqual(importsFromEnv(env), [
    { key: "VERIFIED_ROLE_ID", value: "111" },
    {
      key: "LEGION_ROLES",
      value: [
        { name: "Aegis", roleId: "333" },
        { name: "SDC", roleId: "444" },
      ],
    },
    { key: "VERIFY_CHANNEL_ID", value: "222" },
    { key: "MEE6_TICKET_PARENT_IDS", value: ["555", "666"] },
  ]);
});

test("importsFromEnv skips values that aren't IDs instead of failing", () => {
  assert.deepEqual(importsFromEnv({ VERIFIED_ROLE_ID: "abc", LEGION_ROLES: "Aegis" }), []);
});

test("missingRequired lists required settings that are empty", () => {
  const missing = missingRequired({ VERIFIED_ROLE_ID: "1", MODERATOR_ROLE_ID: null }).map((s) => s.key);
  assert.ok(!missing.includes("VERIFIED_ROLE_ID"));
  assert.ok(!missing.includes("MODERATOR_ROLE_ID"), "optional settings are never missing");
  assert.ok(missing.includes("OFFICERS_ROLE_ID"));
  assert.ok(missing.includes("VERIFY_CHANNEL_ID"));
});

test("toConfigFields maps saved values to the config the rest of the bot reads", () => {
  const fields = toConfigFields({
    VERIFIED_ROLE_ID: "1",
    LEGION_ROLES: [{ name: "Aegis", roleId: "2" }],
    MEE6_TICKET_PARENT_IDS: ["3"],
    ROSTER_CHANNEL_ID: "4",
  });
  assert.equal(fields.verifiedRoleId, "1");
  assert.equal(fields.moderatorRoleId, null);
  assert.deepEqual(fields.legionRoles, [{ name: "Aegis", roleId: "2" }]);
  assert.deepEqual(fields.classRoles, []);
  assert.deepEqual(fields.mee6TicketParentIds, ["3"]);
  assert.equal(fields.roster.channelId, "4");
  assert.equal(fields.roster.forceVcCategoryId, null);
});

test("findProblems spots deleted roles and channels and roles the bot can't give", () => {
  const guild = {
    hasRole: (id) => id !== "gone-role",
    hasChannel: (id) => id !== "gone-channel",
    canGiveRole: (id) => id !== "high-role",
  };
  const problems = findProblems(
    {
      VERIFIED_ROLE_ID: "high-role",
      OFFICERS_ROLE_ID: "high-role",
      VERIFY_CHANNEL_ID: "gone-channel",
      CLASS_ROLES: [{ name: "Ranger", roleId: "gone-role" }],
    },
    guild
  );
  assert.deepEqual(problems, [
    "Verified role: the bot's own role must be above this role to give it out.",
    "Class roles: the role for Ranger was deleted.",
    "Verify channel: the channel or category was deleted.",
  ]);
});

test("describeValue shows mentions or 'not set'", () => {
  assert.equal(describeValue(settingByKey("VERIFIED_ROLE_ID"), "1"), "<@&1>");
  assert.equal(describeValue(settingByKey("VERIFY_CHANNEL_ID"), "2"), "<#2>");
  assert.equal(describeValue(settingByKey("VERIFY_CHANNEL_ID"), null), "not set");
  assert.equal(describeValue(settingByKey("MEE6_TICKET_PARENT_IDS"), ["3", "4"]), "<#3>, <#4>");
  assert.equal(describeValue(settingByKey("LEGION_ROLES"), [{ name: "Aegis", roleId: "5" }]), "Aegis → <@&5>");
  assert.equal(describeValue(settingByKey("LEGION_ROLES"), []), "not set");
});

test("role lists: adding replaces the same name, removing drops it", () => {
  let list = addRoleMapEntry([], "Aegis", "1");
  list = addRoleMapEntry(list, " SDC ", "2");
  list = addRoleMapEntry(list, "aegis", "3");
  assert.deepEqual(list, [
    { name: "aegis", roleId: "3" },
    { name: "SDC", roleId: "2" },
  ]);
  assert.deepEqual(removeRoleMapEntry(list, "AEGIS"), [{ name: "SDC", roleId: "2" }]);
  assert.throws(() => addRoleMapEntry([], "  ", "1"), /name/);
  assert.throws(() => addRoleMapEntry([], "Aegis:x", "1"), /name/);
});

test("server settings in the database", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());

  await t.test("saves, reads and clears settings", () => {
    store.setServerSetting("VERIFIED_ROLE_ID", "1", "admin");
    store.setServerSetting("LEGION_ROLES", [{ name: "Aegis", roleId: "2" }], "admin");
    assert.deepEqual(store.getServerSettings(), {
      VERIFIED_ROLE_ID: "1",
      LEGION_ROLES: [{ name: "Aegis", roleId: "2" }],
    });
    store.setServerSetting("VERIFIED_ROLE_ID", null, "admin");
    assert.deepEqual(Object.keys(store.getServerSettings()), ["LEGION_ROLES"]);
  });

  await t.test("copies from .env only once and never overwrites a saved value", () => {
    const first = store.importServerSettingsOnce([
      { key: "LEGION_ROLES", value: [] },
      { key: "OFFICERS_ROLE_ID", value: "9" },
    ]);
    assert.deepEqual(first, ["OFFICERS_ROLE_ID"]);
    assert.deepEqual(store.getServerSettings().LEGION_ROLES, [{ name: "Aegis", roleId: "2" }]);

    store.setServerSetting("OFFICERS_ROLE_ID", null, "admin");
    assert.equal(store.importServerSettingsOnce([{ key: "OFFICERS_ROLE_ID", value: "9" }]), null);
    assert.equal(store.getServerSettings().OFFICERS_ROLE_ID, undefined);
  });
});
