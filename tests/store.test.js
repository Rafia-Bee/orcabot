const test = require("node:test");
const assert = require("node:assert/strict");
const { openStore } = require("../src/verification/store");

const character = (name, extra = {}) => ({
  name,
  level: 45,
  gearScore: 2500,
  combatPower: 200000,
  ...extra,
});

test("verification claims", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());

  await t.test("saves and reads a claim", () => {
    store.saveVerification({ discordId: "1", character: character("Dieyoung"), method: "auto" });
    assert.equal(store.getVerification("1").char_name, "Dieyoung");
    assert.equal(store.getVerificationByCharName("DIEYOUNG").discord_id, "1");
  });

  await t.test("rejects a character claimed by another account", () => {
    assert.throws(
      () =>
        store.saveVerification({ discordId: "2", character: character("dieyoung"), method: "auto" }),
      (error) => error.code === "CHAR_CLAIMED" && error.claimedBy === "1"
    );
    assert.equal(store.getVerification("2"), null);
  });

  await t.test("same account re-claiming updates in place", () => {
    store.saveVerification({
      discordId: "1",
      character: character("dieyoung", { gearScore: 3500 }),
      method: "gear",
    });
    const claim = store.getVerification("1");
    assert.equal(claim.gear_score, 3500);
    assert.equal(claim.method, "gear");
  });

  await t.test("switching character frees the old name", () => {
    store.saveVerification({ discordId: "1", character: character("Other"), method: "manual" });
    assert.equal(store.getVerificationByCharName("dieyoung"), null);
    store.saveVerification({ discordId: "2", character: character("dieyoung"), method: "auto" });
    assert.equal(store.getVerificationByCharName("dieyoung").discord_id, "2");
  });

  await t.test("delete removes the claim", () => {
    assert.equal(store.deleteVerification("2"), true);
    assert.equal(store.deleteVerification("2"), false);
  });
});

test("character IDs", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());

  await t.test("saves the characterId and finds the claim by it", () => {
    store.saveVerification({ discordId: "1", character: character("KFC", { characterId: "id-1" }), method: "auto" });
    assert.equal(store.getVerification("1").character_id, "id-1");
    assert.equal(store.getVerificationByCharacterId("id-1").discord_id, "1");
    assert.equal(store.getVerificationForCharacter({ name: "Renamed", characterId: "id-1" }).discord_id, "1");
    assert.equal(store.getVerificationByCharacterId(null), null);
  });

  await t.test("a renamed character can't be claimed by another account", () => {
    assert.throws(
      () =>
        store.saveVerification({
          discordId: "2",
          character: character("Renamed", { characterId: "id-1" }),
          method: "auto",
        }),
      (error) => error.code === "CHAR_CLAIMED" && error.claimedBy === "1"
    );
  });

  await t.test("the owner re-claiming the renamed character keeps one claim", () => {
    store.saveVerification({ discordId: "1", character: character("Renamed", { characterId: "id-1" }), method: "auto" });
    assert.equal(store.getVerification("1").char_name, "Renamed");
    assert.equal(store.getVerificationByCharName("KFC"), null);
  });

  await t.test("a lookup without an ID keeps the saved one for the same character", () => {
    store.saveVerification({ discordId: "1", character: character("renamed"), method: "manual" });
    assert.equal(store.getVerification("1").character_id, "id-1");
    store.updateClaimDetails("1", character("Renamed", { gearScore: 3000 }));
    assert.equal(store.getVerification("1").character_id, "id-1");
    assert.equal(store.getVerification("1").gear_score, 3000);
  });

  await t.test("switching to another character drops the old ID", () => {
    store.saveVerification({ discordId: "1", character: character("Alt"), method: "manual" });
    assert.equal(store.getVerification("1").character_id, null);
  });

  await t.test("setCharacterId fills in an ID, and IDs are unique", () => {
    store.saveVerification({ discordId: "3", character: character("Third"), method: "auto" });
    assert.equal(store.setCharacterId("3", "id-3"), true);
    assert.equal(store.getVerificationByCharacterId("id-3").discord_id, "3");
    assert.throws(() => store.setCharacterId("1", "id-3"), /UNIQUE/);
  });
});

test("tickets", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());

  await t.test("create, attach channel, find open ticket", () => {
    const ticket = store.createTicket({
      discordId: "1",
      guildId: "g",
      character: character("dieyoung"),
      reason: "account_too_new",
      slot: "Belt",
    });
    assert.equal(ticket.status, "open");
    assert.equal(ticket.char_name, "dieyoung");
    assert.equal(ticket.character.gearScore, 2500);
    store.setTicketChannel(ticket.id, "chan", "msg");
    assert.equal(store.getOpenTicket("1").channel_id, "chan");
  });

  await t.test("resolve once, reopen after a failed action", () => {
    const { id } = store.getOpenTicket("1");
    assert.equal(store.resolveTicket(id, "banned", "officer1"), true);
    assert.equal(store.resolveTicket(id, "verified", "officer2"), false);
    assert.equal(store.getOpenTicket("1"), null);

    store.reopenTicket(id);
    assert.equal(store.getOpenTicket("1").id, id);
    assert.equal(store.getTicket(id).resolved_by, null);
  });

  await t.test("delete", () => {
    const { id } = store.getOpenTicket("1");
    store.deleteTicket(id);
    assert.equal(store.getTicket(id), null);
  });
});

test("review cases", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());

  await t.test("create, attach message, resolve once", () => {
    const reviewCase = store.createReviewCase({
      discordId: "1",
      charName: "dieyoung",
      reason: "account_too_new",
      character: character("dieyoung"),
    });
    assert.equal(reviewCase.status, "open");
    assert.equal(reviewCase.character.gearScore, 2500);
    assert.equal(store.getOpenReviewCase("1").id, reviewCase.id);

    store.setReviewMessage(reviewCase.id, "chan", "msg");
    assert.equal(store.getReviewCase(reviewCase.id).message_id, "msg");

    assert.equal(store.resolveReviewCase(reviewCase.id, "approved", "mod1"), true);
    assert.equal(store.resolveReviewCase(reviewCase.id, "denied", "mod2"), false);
    assert.equal(store.getReviewCase(reviewCase.id).resolved_by, "mod1");
    assert.equal(store.getOpenReviewCase("1"), null);
  });

  await t.test("case without a character lookup", () => {
    const reviewCase = store.createReviewCase({ discordId: "2", reason: "shugo_unavailable" });
    assert.equal(reviewCase.character, null);
  });
});

test("scheduled grants", () => {
  const store = openStore(":memory:");
  const now = Date.now();
  store.scheduleGrant({ discordId: "1", guildId: "g", charName: "dieyoung", dueAt: now + 60_000 });
  store.scheduleGrant({ discordId: "2", guildId: "g", charName: "other", dueAt: now - 1 });
  assert.equal(store.getScheduledGrant("1").char_name, "dieyoung");
  assert.deepEqual(store.getDueGrants(now).map((g) => g.discord_id), ["2"]);

  store.scheduleGrant({ discordId: "1", guildId: "g", charName: "dieyoung", dueAt: now - 5 });
  assert.deepEqual(store.getDueGrants(now).map((g) => g.discord_id), ["1", "2"]);

  assert.equal(store.deleteScheduledGrant("1"), true);
  assert.equal(store.getScheduledGrant("1"), null);
  store.close();
});

test("cooldowns", () => {
  const store = openStore(":memory:");
  assert.equal(store.getCooldownRemaining("1"), 0);
  store.setCooldown("1", 60_000);
  const remaining = store.getCooldownRemaining("1");
  assert.ok(remaining > 59_000 && remaining <= 60_000);
  store.pruneCooldowns(Date.now() + 61_000);
  assert.equal(store.getCooldownRemaining("1"), 0);
  store.close();
});
