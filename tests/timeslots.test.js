const test = require("node:test");
const assert = require("node:assert/strict");
const { zonedDateTime, nextOccurrence, clock } = require("../src/time");
const { planSlots, pickableSlots, dueSlots, nextEarlySlot, isFinished } = require("../src/timeslots/schedule");
const { openStore } = require("../src/verification/store");

const TZ = "Europe/Berlin";
const EVENT_START = 1793644200_000;
const MIN = 60_000;

test("time zone helpers", async (t) => {
  await t.test("wall-clock time in winter (CET, UTC+1)", () => {
    assert.equal(zonedDateTime({ year: 2026, month: 11, day: 2 }, "09:00", TZ), Date.UTC(2026, 10, 2, 8, 0));
  });

  await t.test("wall-clock time in summer (CEST, UTC+2)", () => {
    assert.equal(zonedDateTime({ year: 2026, month: 7, day: 1 }, "09:00", TZ), Date.UTC(2026, 6, 1, 7, 0));
  });

  await t.test("next occurrence is later today or tomorrow", () => {
    const now = Date.UTC(2026, 10, 2, 10, 0);
    assert.equal(nextOccurrence("12:00", TZ, now), Date.UTC(2026, 10, 2, 11, 0));
    assert.equal(nextOccurrence("04:00", TZ, now), Date.UTC(2026, 10, 3, 3, 0));
  });

  await t.test("next occurrence across the switch to winter time", () => {
    const now = Date.UTC(2026, 9, 24, 12, 0);
    assert.equal(nextOccurrence("04:00", TZ, now), Date.UTC(2026, 9, 25, 3, 0));
  });

  await t.test("clock formats in the time zone", () => {
    assert.equal(clock(Date.UTC(2026, 10, 2, 8, 20), TZ), "09:20");
  });
});

test("planning timeslots", async (t) => {
  const base = { eventStart: EVENT_START, first: "09:00", last: "16:00", durationMinutes: 20, timeZone: TZ };
  const early = Date.UTC(2026, 10, 1, 12, 0);

  await t.test("one 20 min slot per force leader from FIRST_TIMESLOT", () => {
    const plan = planSlots({ ...base, leaderCount: 20, now: early });
    assert.equal(plan.slots.length, 20);
    assert.equal(plan.fits, 21);
    assert.equal(plan.slots[0].startsAt, Date.UTC(2026, 10, 2, 8, 0));
    assert.equal(plan.slots[19].endsAt, Date.UTC(2026, 10, 2, 14, 40));
  });

  await t.test("caps at what fits before LAST_TIMESLOT", () => {
    const plan = planSlots({ ...base, leaderCount: 25, now: early });
    assert.equal(plan.slots.length, 21);
    assert.equal(plan.slots[20].endsAt, Date.UTC(2026, 10, 2, 15, 0));
  });

  await t.test("starts at the next 5 minutes when the window already began", () => {
    const plan = planSlots({ ...base, leaderCount: 30, now: Date.UTC(2026, 10, 2, 9, 2) });
    assert.equal(plan.startedLate, true);
    assert.equal(plan.slots[0].startsAt, Date.UTC(2026, 10, 2, 9, 5));
    assert.equal(plan.slots.length, 17);
  });

  await t.test("rejects LAST_TIMESLOT before FIRST_TIMESLOT", () => {
    assert.throws(() => planSlots({ ...base, last: "08:00", leaderCount: 5, now: early }), /must be later/);
  });
});

function slots(specs) {
  return specs.map((spec, i) => ({
    slot_index: i,
    starts_at: i * 20 * MIN,
    ends_at: (i + 1) * 20 * MIN,
    user_id: null,
    reminded_at: null,
    done_at: null,
    ...spec,
  }));
}

test("whose turn it is", async (t) => {
  await t.test("reminds a claimed slot when it starts", () => {
    const list = slots([{ user_id: "a" }, { user_id: "b" }]);
    assert.deepEqual(dueSlots(list, 5 * MIN).map((s) => s.user_id), ["a"]);
    assert.deepEqual(dueSlots(list, 25 * MIN).map((s) => s.user_id), ["b"]);
  });

  await t.test("after I'm done, the next claimed slot starts early, skipping free ones", () => {
    const list = slots([{ user_id: "a", reminded_at: 0, done_at: 5 * MIN }, {}, { user_id: "c" }]);
    assert.equal(nextEarlySlot(list, 6 * MIN).user_id, "c");
  });

  await t.test("no early start while someone is still editing", () => {
    const list = slots([{ user_id: "a", reminded_at: 0 }, { user_id: "b" }]);
    assert.equal(nextEarlySlot(list, 6 * MIN), null);
  });

  await t.test("no early start before the first turn", () => {
    assert.equal(nextEarlySlot(slots([{ user_id: "a" }]), 0), null);
  });

  await t.test("free slots before the current turn can't be picked", () => {
    const list = slots([{}, { user_id: "b", reminded_at: 0 }, {}, {}]);
    assert.deepEqual(pickableSlots(list, 0).map((s) => s.slot_index), [2, 3]);
  });

  await t.test("finished once the last slot ends", () => {
    const list = slots([{}, {}]);
    assert.equal(isFinished(list, 39 * MIN), false);
    assert.equal(isFinished(list, 40 * MIN), true);
  });
});

test("timeslot store", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const board = store.createTimeslotBoard({
    raidEventId: "1566217435068244090",
    title: "ARTIFACT SIEGE",
    guildId: "g",
    channelId: "c",
    eventStart: EVENT_START,
    createdBy: "u",
    slots: [
      { startsAt: 0, endsAt: 20 * MIN },
      { startsAt: 20 * MIN, endsAt: 40 * MIN },
    ],
  });

  await t.test("creates the board with its slots", () => {
    assert.equal(store.getOpenTimeslotBoardForEvent("1566217435068244090").id, board.id);
    assert.equal(store.getTimeslots(board.id).length, 2);
  });

  await t.test("one slot per person, picking again moves it", () => {
    assert.equal(store.claimTimeslot(board.id, 0, "a"), true);
    assert.equal(store.claimTimeslot(board.id, 0, "b"), false);
    assert.equal(store.claimTimeslot(board.id, 1, "a"), true);
    assert.deepEqual(store.getTimeslots(board.id).map((s) => s.user_id), [null, "a"]);
  });

  await t.test("done can only be marked once", () => {
    store.markTimeslotReminded(board.id, 1, "m");
    assert.equal(store.markTimeslotDone(board.id, 1), true);
    assert.equal(store.markTimeslotDone(board.id, 1), false);
  });

  await t.test("a slot whose turn started can't be released", () => {
    assert.equal(store.releaseTimeslot(board.id, "a"), false);
  });

  await t.test("closing hides the board from open lists", () => {
    assert.equal(store.closeTimeslotBoard(board.id), true);
    assert.equal(store.getOpenTimeslotBoards().length, 0);
  });
});
