const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLegionRoles, parseClassRoles } = require("../src/verification/config");
const { legionRoleFor, classRoleFor } = require("../src/verification/access");

const legionRoles = parseLegionRoles(
  "Aegis:111, SDC:222,Failure:333,IDF:444,Sabotage:555,通通200:666"
);
const cfg = { legionRoles, guestRoleId: "999" };

test("parses LEGION_ROLES", () => {
  assert.deepEqual(legionRoles.map((l) => `${l.name}=${l.roleId}`), [
    "Aegis=111",
    "SDC=222",
    "Failure=333",
    "IDF=444",
    "Sabotage=555",
    "通通200=666",
  ]);
  assert.deepEqual(parseLegionRoles(""), []);
  assert.deepEqual(parseLegionRoles(undefined), []);
});

test("rejects malformed LEGION_ROLES entries", () => {
  assert.throws(() => parseLegionRoles("Aegis"), /LEGION_ROLES entry .* must look like Name:roleId/);
  assert.throws(() => parseLegionRoles("Aegis:"), /LEGION_ROLES entry .* must look like Name:roleId/);
  assert.throws(() => parseLegionRoles(":111"), /LEGION_ROLES entry .* must look like Name:roleId/);
  assert.throws(() => parseLegionRoles("Aegis:abc"), /LEGION_ROLES entry .* must look like Name:roleId/);
});

test("matches legions ignoring capitals and spaces", () => {
  assert.equal(legionRoleFor(cfg, "Aegis"), "111");
  assert.equal(legionRoleFor(cfg, "sdc"), "222");
  assert.equal(legionRoleFor(cfg, " Failure "), "333");
  assert.equal(legionRoleFor(cfg, "通通200"), "666");
});

test("no matching legion or no legion gets Guest", () => {
  assert.equal(legionRoleFor(cfg, "SomeOtherLegion"), "999");
  assert.equal(legionRoleFor(cfg, null), "999");
  assert.equal(legionRoleFor(cfg, ""), "999");
  assert.equal(legionRoleFor({ legionRoles, guestRoleId: null }, "Other"), null);
});

test("unknown legion (no character data) gets nothing", () => {
  assert.equal(legionRoleFor(cfg, undefined), undefined);
});

const classRoles = parseClassRoles("Gladiator:1,Templar:2,Assassin:3,Ranger:4,Sorcerer:5,Spiritmaster:6,Cleric:7,Chanter:8");
const classCfg = { classRoles };

test("parses CLASS_ROLES and names the setting in errors", () => {
  assert.equal(classRoles.length, 8);
  assert.throws(() => parseClassRoles("Ranger"), /CLASS_ROLES entry .* must look like Name:roleId/);
});

test("matches classes ignoring capitals, no fallback role", () => {
  assert.equal(classRoleFor(classCfg, "Ranger"), "4");
  assert.equal(classRoleFor(classCfg, "spiritmaster"), "6");
  assert.equal(classRoleFor(classCfg, "Painter"), null);
  assert.equal(classRoleFor(classCfg, null), null);
  assert.equal(classRoleFor(classCfg, undefined), undefined);
});
