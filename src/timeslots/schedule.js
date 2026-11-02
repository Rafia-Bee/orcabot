const { zonedParts, zonedDateTime } = require("../time");

const MAX_SLOTS = 50;
const ROUND_START_MS = 5 * 60 * 1000;

function planSlots({ eventStart, first, last, durationMinutes, timeZone, leaderCount, now = Date.now() }) {
  const day = zonedParts(eventStart, timeZone);
  const windowStart = zonedDateTime(day, first, timeZone);
  const windowEnd = zonedDateTime(day, last, timeZone);
  if (windowEnd <= windowStart) {
    throw new Error(`LAST_TIMESLOT (${last}) must be later than FIRST_TIMESLOT (${first})`);
  }

  const durationMs = durationMinutes * 60 * 1000;
  const start = Math.max(windowStart, Math.ceil(now / ROUND_START_MS) * ROUND_START_MS);
  const fits = Math.max(0, Math.floor((windowEnd - start) / durationMs));
  const count = Math.min(leaderCount, fits, MAX_SLOTS);
  const slots = Array.from({ length: count }, (_, i) => ({
    startsAt: start + i * durationMs,
    endsAt: start + (i + 1) * durationMs,
  }));
  return { slots, fits: Math.min(fits, MAX_SLOTS), windowStart, windowEnd, startedLate: start > windowStart };
}

function isActive(slot, now) {
  return slot.reminded_at !== null && slot.done_at === null && slot.ends_at > now;
}

function lastRemindedIndex(slots) {
  return slots.reduce((max, slot) => (slot.reminded_at !== null ? Math.max(max, slot.slot_index) : max), -1);
}

function pickableSlots(slots, now = Date.now()) {
  const after = lastRemindedIndex(slots);
  return slots.filter((slot) => slot.user_id === null && slot.ends_at > now && slot.slot_index > after);
}

function dueSlots(slots, now = Date.now()) {
  return slots.filter(
    (slot) => slot.user_id !== null && slot.reminded_at === null && slot.starts_at <= now && slot.ends_at > now
  );
}

function nextEarlySlot(slots, now = Date.now()) {
  const after = lastRemindedIndex(slots);
  if (after < 0 || slots.some((slot) => isActive(slot, now))) return null;
  return (
    slots.find(
      (slot) => slot.slot_index > after && slot.user_id !== null && slot.reminded_at === null && slot.ends_at > now
    ) ?? null
  );
}

function isFinished(slots, now = Date.now()) {
  return slots.length === 0 || slots[slots.length - 1].ends_at <= now;
}

module.exports = { MAX_SLOTS, planSlots, isActive, pickableSlots, dueSlots, nextEarlySlot, isFinished };
