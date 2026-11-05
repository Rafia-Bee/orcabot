// Rules for comp editing timeslots, kept free of Discord and the database so they're easy to test.
// parseClock: reads a typed 24-hour time like 18:30, 18.30 or 1830.
// dateChoices: the dates someone can pick, from today to the last day a timeslot can start, in their time zone.
// checkPick: says why a picked start time isn't allowed (past, too close to the event, overlaps someone), or null.
// isActive: whether a timeslot's turn is running right now.
// splitSlots: upcoming timeslots in time order, and past ones (done or ended).
// dueSlots: timeslots whose start time has come and haven't been pinged yet.
// nextEarlySlot: the next timeslot to ping early after someone's done, if it starts soon enough.
const { zonedParts } = require("../time");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DATES = 25;
const GRACE_MS = 60 * 1000;

function parseClock(text) {
  const match = String(text ?? "").trim().match(/^(\d{1,2})[:.]?(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function dateChoices({ now, latestStart, timeZone }) {
  if (latestStart < now) return [];
  const toDate = ({ year, month, day }) => Date.UTC(year, month - 1, day);
  const first = toDate(zonedParts(now, timeZone));
  const last = toDate(zonedParts(latestStart, timeZone));
  const dates = [];
  for (let day = first; day <= last && dates.length < MAX_DATES; day += DAY_MS) {
    const date = new Date(day);
    dates.push({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
  }
  return dates;
}

function checkPick({ startsAt, durationMs, eventStart, minGapMs, slots, userId, now }) {
  const endsAt = startsAt + durationMs;
  if (startsAt + GRACE_MS <= now) return { problem: "past" };
  if (endsAt > eventStart - minGapMs) return { problem: "too_late" };
  const clash = slots.find(
    (slot) => slot.user_id !== userId && slot.done_at === null && slot.starts_at < endsAt && slot.ends_at > startsAt
  );
  return clash ? { problem: "overlap", slot: clash } : null;
}

function isActive(slot, now) {
  return slot.reminded_at !== null && slot.done_at === null && slot.ends_at > now;
}

function byStart(a, b) {
  return a.starts_at - b.starts_at;
}

function splitSlots(slots, now = Date.now()) {
  const isPast = (slot) => slot.done_at !== null || slot.ends_at <= now;
  return {
    upcoming: slots.filter((slot) => !isPast(slot)).sort(byStart),
    past: slots.filter(isPast).sort(byStart),
  };
}

function dueSlots(slots, now = Date.now()) {
  return slots.filter((slot) => slot.reminded_at === null && slot.starts_at <= now && slot.ends_at > now);
}

function nextEarlySlot(slots, now, windowMs) {
  if (slots.some((slot) => isActive(slot, now))) return null;
  const next = slots.filter((slot) => slot.reminded_at === null && slot.ends_at > now).sort(byStart)[0];
  return next && next.starts_at - now <= windowMs ? next : null;
}

module.exports = { parseClock, dateChoices, checkPick, isActive, splitSlots, dueSlots, nextEarlySlot };
