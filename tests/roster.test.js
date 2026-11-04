const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRaidHelperId, buildForces, channelKey, rosterMessages } = require("../src/roster/comp");

const groups = Array.from({ length: 12 }, (_, i) => ({
  name: `Group ${i + 1}`,
  position: i + 2 + Math.floor(i / 4),
}));
const comp = {
  id: "1565489833873383515",
  title: "Composition Tool",
  groups,
  dividers: [
    { name: "Force 1", position: 1 },
    { name: "Force 2 (Backline)", position: 6 },
    { name: "Force 3", position: 11 },
  ],
  slots: [
    { userId: "13", name: "Late", groupNumber: 9, slotNumber: 1 },
    { userId: "2", name: "IcyChant", groupNumber: 1, slotNumber: 3 },
    { userId: "1", name: "Xia", groupNumber: 1, slotNumber: 1 },
    { userId: "4", name: "Nini", groupNumber: 4, slotNumber: 2 },
    { userId: "5", name: "Shaia", groupNumber: 5, slotNumber: 1 },
  ],
};

test("groups sit under the divider before them, slots follow their group number", () => {
  const { forces, unassigned } = buildForces(comp);
  assert.deepEqual(
    forces.map((f) => [f.name, f.groups, f.slots.map((s) => s.name)]),
    [
      ["Force 1", [1, 2, 3, 4], ["Xia", "IcyChant", "Nini"]],
      ["Force 2 (Backline)", [5, 6, 7, 8], ["Shaia"]],
      ["Force 3", [9, 10, 11, 12], ["Late"]],
    ]
  );
  assert.deepEqual(unassigned, []);
});

test("groups above the first divider are unassigned", () => {
  const { forces, unassigned } = buildForces({
    groups: [{ position: 1 }, { position: 3 }],
    dividers: [{ name: "Force 1", position: 2 }],
    slots: [
      { userId: "1", name: "Top", groupNumber: 1, slotNumber: 1 },
      { userId: "2", name: "Under", groupNumber: 2, slotNumber: 1 },
    ],
  });
  assert.deepEqual(forces[0].slots.map((s) => s.name), ["Under"]);
  assert.deepEqual(unassigned.map((s) => s.name), ["Top"]);
});

test("comp IDs come from plain IDs and links", () => {
  assert.equal(parseRaidHelperId("1565489833873383515"), "1565489833873383515");
  assert.equal(parseRaidHelperId("https://raid-helper.xyz/comp/1565489833873383515"), "1565489833873383515");
  assert.equal(parseRaidHelperId(" 1565489833873383515 "), "1565489833873383515");
  assert.equal(parseRaidHelperId("force 1"), null);
});

test("voice channel names match ignoring case, symbols and bracketed notes", () => {
  assert.equal(channelKey("Force 2 (Backline)"), channelKey("force-2"));
  assert.equal(channelKey("🔊・Force 1"), channelKey("Force 1"));
  assert.notEqual(channelKey("Force 1"), channelKey("Force 10"));
});

test("roster message names the VC, the leader and pings the members", () => {
  const [message] = rosterMessages({
    voiceChannelId: "900",
    leaderId: "1",
    leaderCharName: "Xia",
    generalChannelId: "800",
    memberIds: ["2", "4"],
  });
  assert.equal(
    message,
    "### Join <#900> and whisper <@1> (**Xia**) in game to get invited to your force. " +
      "If you can't make it, please ping <@1> to let them know in <#800>.\n<@2> <@4>"
  );
});

test("roster message after the first force starts with a divider", () => {
  const [message] = rosterMessages({ voiceChannelId: "900", leaderId: "1", memberIds: ["2"], divided: true });
  assert.match(message, /^--------------\n### Join <#900>/);
});

test("roster message without a leader or general channel still reads", () => {
  const [message] = rosterMessages({ voiceChannelId: "900", leaderId: null, memberIds: ["2"] });
  assert.match(message, /whisper your force leader in game/);
  assert.match(message, /in #general\.\n<@2>$/);
});

test("long rosters are split under Discord's 2000 character limit", () => {
  const memberIds = Array.from({ length: 120 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const messages = rosterMessages({ voiceChannelId: "900", leaderId: "1", memberIds });
  assert.ok(messages.length > 1);
  assert.ok(messages.every((m) => m.length <= 2000));
  assert.equal(messages.join(" ").match(/<@\d{18}>/g).length, 120);
});
