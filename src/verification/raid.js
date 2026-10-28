const { getConfig } = require("./config");
const { COLORS, buildEventEmbed, postLog, unixSeconds } = require("./embeds");

let recent = [];
let pausedUntil = 0;
let turnedAway = 0;
let resumeTimer = null;

function prune(now) {
  const cutoff = now - getConfig().raid.windowSeconds * 1000;
  recent = recent.filter((time) => time > cutoff);
}

function isPaused(now = Date.now()) {
  return now < pausedUntil;
}

function getPauseState() {
  return { paused: isPaused(), pausedUntil };
}

function startPause(client, now, extended) {
  const { submissionsThreshold, windowSeconds, pauseMinutes } = getConfig().raid;
  pausedUntil = now + pauseMinutes * 60_000;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => endPause(client), pauseMinutes * 60_000);
  resumeTimer.unref?.();

  const until = unixSeconds(pausedUntil);
  postLog(
    client,
    buildEventEmbed({
      color: COLORS.red,
      title: extended ? "Verification pause extended" : "Verification paused (possible raid)",
      description:
        `${recent.length} Verify submissions in the last ${windowSeconds} s (limit ${submissionsThreshold}). ` +
        `New submissions are paused until <t:${until}:t> (<t:${until}:R>). ` +
        "Members are asked to try again in a few minutes.",
    })
  );
}

function endPause(client) {
  const now = Date.now();
  prune(now);
  if (recent.length > getConfig().raid.submissionsThreshold) {
    startPause(client, now, true);
    return;
  }
  pausedUntil = 0;
  const count = turnedAway;
  turnedAway = 0;
  postLog(
    client,
    buildEventEmbed({
      color: COLORS.green,
      title: "Verification resumed",
      description: `${count} submission${count === 1 ? " was" : "s were"} turned away during the pause.`,
    })
  );
}

function recordSubmission(client, now = Date.now()) {
  recent.push(now);
  prune(now);
  if (!isPaused(now) && recent.length > getConfig().raid.submissionsThreshold) {
    startPause(client, now, false);
  }
  if (isPaused(now)) {
    turnedAway++;
    return true;
  }
  return false;
}

module.exports = { recordSubmission, isPaused, getPauseState };
