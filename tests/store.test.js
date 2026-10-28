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

test("gear challenges", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());

  const baseline = { Belt: { id: 215230001, name: "Noble Belt" } };

  await t.test("create, read back, count attempts", () => {
    const challenge = store.createChallenge({
      discordId: "1",
      charName: "dieyoung",
      slot: "Belt",
      baseline,
      ttlMs: 15 * 60_000,
    });
    assert.deepEqual(challenge.baseline, baseline);
    assert.equal(challenge.expires_at - challenge.issued_at, 15 * 60_000);
    assert.equal(store.getChallengeForUser("1").id, challenge.id);
    assert.equal(store.recordChallengeAttempt(challenge.id), 1);
    assert.equal(store.recordChallengeAttempt(challenge.id), 2);
  });

  await t.test("a new challenge replaces the old one and resets attempts", () => {
    const old = store.getChallengeForUser("1");
    const fresh = store.createChallenge({
      discordId: "1",
      charName: "dieyoung",
      slot: "Belt",
      baseline,
      ttlMs: 1,
      reviewCaseId: 7,
    });
    assert.equal(fresh.id, old.id);
    assert.equal(fresh.attempts, 0);
    assert.equal(fresh.review_case_id, 7);
  });

  await t.test("expired challenges are listed and can be deleted", () => {
    const [expired] = store.getExpiredChallenges(Date.now() + 10);
    assert.equal(expired.discord_id, "1");
    assert.equal(store.deleteChallenge(expired.id), true);
    assert.equal(store.getChallengeForUser("1"), null);
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
