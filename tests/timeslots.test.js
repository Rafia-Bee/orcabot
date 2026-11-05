const test = require("node:test");
const assert = require("node:assert/strict");
const { zonedDateTime, nextOccurrence, clock, isValidTimeZone } = require("../src/time");
const {
  parseClock,
  dateChoices,
  checkPick,
  splitSlots,
  dueSlots,
  nextEarlySlot,
} = require("../src/timeslots/schedule");
const { zoneOptions } = require("../src/timeslots/zones");
const { openStore } = require("../src/verification/store");
const { renderBoard } = require("../src/timeslots/board");

const TZ = "Europe/Berlin";
const EVENT_START = 1793644200_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

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

test("reading a typed start time", () => {
  assert.equal(parseClock("18:30"), "18:30");
  assert.equal(parseClock(" 8:05 "), "08:05");
  assert.equal(parseClock("18.30"), "18:30");
  assert.equal(parseClock("1830"), "18:30");
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("18:60"), null);
  assert.equal(parseClock("evening"), null);
});

test("dates to pick from", async (t) => {
  const now = Date.UTC(2026, 9, 31, 12, 0);
  const latestStart = EVENT_START - 3 * HOUR - 30 * MIN;

  await t.test("run from today to the event day", () => {
    assert.deepEqual(dateChoices({ now, latestStart, timeZone: TZ }), [
      { year: 2026, month: 10, day: 31 },
      { year: 2026, month: 11, day: 1 },
      { year: 2026, month: 11, day: 2 },
    ]);
  });

  await t.test("follow the picker's own time zone", () => {
    assert.deepEqual(dateChoices({ now, latestStart, timeZone: "Pacific/Auckland" }), [
      { year: 2026, month: 11, day: 1 },
      { year: 2026, month: 11, day: 2 },
      { year: 2026, month: 11, day: 3 },
    ]);
  });

  await t.test("are empty once it's too late to pick", () => {
    assert.deepEqual(dateChoices({ now: latestStart + MIN, latestStart, timeZone: TZ }), []);
  });
});

test("checking a picked time", async (t) => {
  const now = EVENT_START - 10 * HOUR;
  const other = { user_id: "b", starts_at: EVENT_START - 5 * HOUR, ends_at: EVENT_START - 4.5 * HOUR, done_at: null };
  const check = (startsAt, slots = [other]) =>
    checkPick({ startsAt, durationMs: 30 * MIN, eventStart: EVENT_START, minGapMs: 3 * HOUR, slots, userId: "a", now });

  await t.test("a free time is fine", () => {
    assert.equal(check(EVENT_START - 7 * HOUR), null);
  });

  await t.test("must end at least 3 hours before the event", () => {
    assert.equal(check(EVENT_START - 3.5 * HOUR), null);
    assert.equal(check(EVENT_START - 3 * HOUR - 20 * MIN).problem, "too_late");
  });

  await t.test("can't be in the past", () => {
    assert.equal(check(now - 2 * MIN).problem, "past");
  });

  await t.test("can't overlap someone else's timeslot", () => {
    const result = check(EVENT_START - 4 * HOUR - 45 * MIN);
    assert.equal(result.problem, "overlap");
    assert.equal(result.slot, other);
    assert.equal(check(EVENT_START - 4.5 * HOUR), null);
    assert.equal(check(EVENT_START - 5.5 * HOUR), null);
  });

  await t.test("may overlap your own or a finished timeslot", () => {
    const start = EVENT_START - 4 * HOUR - 45 * MIN;
    assert.equal(check(start, [{ ...other, user_id: "a" }]), null);
    assert.equal(check(start, [{ ...other, done_at: now }]), null);
  });
});

function slot(spec) {
  return { slot_index: 0, user_id: "a", reminded_at: null, done_at: null, ...spec };
}

test("whose turn it is", async (t) => {
  await t.test("reminds a slot when it starts", () => {
    const list = [slot({ user_id: "a", starts_at: 0, ends_at: 30 * MIN }), slot({ user_id: "b", starts_at: HOUR, ends_at: 90 * MIN })];
    assert.deepEqual(dueSlots(list, 5 * MIN).map((s) => s.user_id), ["a"]);
    assert.deepEqual(dueSlots(list, 65 * MIN).map((s) => s.user_id), ["b"]);
  });

  await t.test("upcoming slots come in time order, finished ones go to past", () => {
    const list = [
      slot({ user_id: "late", starts_at: 5 * HOUR, ends_at: 5.5 * HOUR }),
      slot({ user_id: "done", starts_at: HOUR, ends_at: 1.5 * HOUR, reminded_at: HOUR, done_at: 1.2 * HOUR }),
      slot({ user_id: "ended", starts_at: 0, ends_at: 0.5 * HOUR, reminded_at: 0 }),
      slot({ user_id: "now", starts_at: 1.5 * HOUR, ends_at: 2 * HOUR, reminded_at: 1.5 * HOUR }),
      slot({ user_id: "soon", starts_at: 3 * HOUR, ends_at: 3.5 * HOUR }),
    ];
    const { upcoming, past } = splitSlots(list, 1.7 * HOUR);
    assert.deepEqual(upcoming.map((s) => s.user_id), ["now", "soon", "late"]);
    assert.deepEqual(past.map((s) => s.user_id), ["ended", "done"]);
  });

  await t.test("after I'm done, the next slot starts early if it's within 2 hours", () => {
    const list = [slot({ user_id: "a", starts_at: 0, ends_at: 30 * MIN, reminded_at: 0, done_at: 10 * MIN })];
    const soon = [...list, slot({ user_id: "b", starts_at: 2 * HOUR, ends_at: 2.5 * HOUR })];
    const later = [...list, slot({ user_id: "b", starts_at: 2.5 * HOUR, ends_at: 3 * HOUR })];
    assert.equal(nextEarlySlot(soon, 10 * MIN, 2 * HOUR).user_id, "b");
    assert.equal(nextEarlySlot(later, 10 * MIN, 2 * HOUR), null);
  });

  await t.test("no early start while someone is still editing", () => {
    const list = [
      slot({ user_id: "a", starts_at: 0, ends_at: 30 * MIN, reminded_at: 0 }),
      slot({ user_id: "b", starts_at: HOUR, ends_at: 1.5 * HOUR }),
    ];
    assert.equal(nextEarlySlot(list, 10 * MIN, 2 * HOUR), null);
  });
});

test("timezone choices are real zones that show their current time", () => {
  const now = Date.UTC(2026, 10, 2, 8, 20);
  const options = zoneOptions(now);
  assert.ok(options.length <= 25);
  assert.ok(options.every((o) => isValidTimeZone(o.value)));
  const berlin = options.find((o) => o.value === "Europe/Berlin");
  assert.match(berlin.description, /09:20/);
});

test("the board lists upcoming timeslots first, in time order, then past ones", () => {
  const board = { id: 1, title: "Siege", status: "open", event_start: EVENT_START };
  const now = EVENT_START - 6 * HOUR;
  const list = [
    slot({ user_id: "111", starts_at: EVENT_START - 8 * HOUR, ends_at: EVENT_START - 7.5 * HOUR, reminded_at: 1, done_at: 2 }),
    slot({ user_id: "333", starts_at: EVENT_START - 4 * HOUR, ends_at: EVENT_START - 3.5 * HOUR }),
    slot({ user_id: "222", starts_at: EVENT_START - 5 * HOUR, ends_at: EVENT_START - 4.5 * HOUR }),
  ];
  const { embeds, components } = renderBoard(board, list, now);
  const text = embeds[0].data.description;
  const order = ["**Upcoming**", "<@222>", "<@333>", "**Past timeslots**", "<@111>"].map((part) => text.indexOf(part));
  assert.ok(order.every((at) => at >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.deepEqual(
    components.flatMap((row) => row.components.map((c) => c.data.label)),
    ["Pick a time", "Give up my timeslot", "Change my timezone"]
  );
});

test("a board for an event that has started is closed", () => {
  const board = { id: 1, title: "Siege", status: "open", event_start: EVENT_START };
  const { embeds, components } = renderBoard(board, [], EVENT_START);
  assert.match(embeds[0].data.description, /closed/);
  assert.deepEqual(components, []);
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
  });
  const byUser = (user) => store.getTimeslots(board.id).find((s) => s.user_id === user);

  await t.test("creates an empty board", () => {
    assert.equal(store.getOpenTimeslotBoardForEvent("1566217435068244090").id, board.id);
    assert.equal(store.getTimeslots(board.id).length, 0);
  });

  await t.test("picking adds a timeslot, picking again moves it, listed by start time", () => {
    assert.equal(store.pickTimeslot(board.id, "a", 0, 30 * MIN), true);
    assert.equal(store.pickTimeslot(board.id, "b", HOUR, 90 * MIN), true);
    assert.equal(store.pickTimeslot(board.id, "a", 2 * HOUR, 150 * MIN), true);
    assert.deepEqual(
      store.getTimeslots(board.id).map((s) => [s.user_id, s.starts_at]),
      [["b", HOUR], ["a", 2 * HOUR]]
    );
  });

  await t.test("done can only be marked once", () => {
    const mine = byUser("a");
    store.markTimeslotReminded(board.id, mine.slot_index, "m");
    assert.equal(store.markTimeslotDone(board.id, mine.slot_index), true);
    assert.equal(store.markTimeslotDone(board.id, mine.slot_index), false);
  });

  await t.test("a slot whose turn started can't be moved or given up", () => {
    assert.equal(store.pickTimeslot(board.id, "a", 4 * HOUR, 270 * MIN), false);
    assert.equal(store.releaseTimeslot(board.id, "a"), false);
    assert.equal(byUser("a").starts_at, 2 * HOUR);
  });

  await t.test("giving up removes the timeslot", () => {
    assert.equal(store.releaseTimeslot(board.id, "b"), true);
    assert.equal(byUser("b"), undefined);
  });

  await t.test("remembers each person's time zone", () => {
    assert.equal(store.getUserTimeZone("a"), null);
    store.setUserTimeZone("a", "Europe/London");
    store.setUserTimeZone("a", "Asia/Seoul");
    assert.equal(store.getUserTimeZone("a"), "Asia/Seoul");
  });

  await t.test("closing hides the board from open lists", () => {
    assert.equal(store.closeTimeslotBoard(board.id), true);
    assert.equal(store.getOpenTimeslotBoards().length, 0);
  });
});
