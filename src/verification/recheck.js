const { escapeMarkdown } = require("discord.js");
const { getConfig } = require("./config");
const { getStore } = require("./store");
const { lookupCharacter } = require("./shugo");
const { applyCharacterRoles } = require("./access");
const { openReviewCase } = require("./review");
const { COLORS, buildEventEmbed, postLog } = require("./embeds");

const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_LIST_LINES = 15;

let running = null;

function getRunningRecheck() {
  return running;
}

function same(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

async function recheckClaim(client, guild, claim) {
  const cfg = getConfig();
  const store = getStore();

  const member = await guild.members.fetch(claim.discord_id).catch(() => null);
  if (!member) return { status: "left", claim };
  if (!member.roles.cache.has(cfg.verifiedRoleId)) return { status: "not_verified", claim };

  const lookup = await lookupCharacter(claim.char_name, { fresh: true });
  if (lookup.status === "unavailable" || lookup.status === "invalid_name") {
    return { status: "lookup_failed", claim, reason: lookup.reason ?? lookup.status };
  }

  let reviewReason = null;
  const character = lookup.status === "found" ? lookup.character : null;
  if (!character) reviewReason = "recheck_not_found";
  else if (!same(character.faction, cfg.requiredFaction)) reviewReason = "recheck_wrong_faction";
  else if (!same(character.server, cfg.requiredServer)) reviewReason = "recheck_wrong_server";

  if (reviewReason) {
    if (store.getOpenReviewCase(claim.discord_id)) {
      return { status: "review", claim, reason: reviewReason, alreadyOpen: true };
    }
    const reviewCase = await openReviewCase(client, {
      discordId: claim.discord_id,
      charName: claim.char_name,
      reason: reviewReason,
      character,
      context: {},
    });
    return { status: "review", claim, reason: reviewReason, caseId: reviewCase.id };
  }

  const changes = [];
  if (!same(claim.legion, character.legion)) {
    changes.push(`legion ${claim.legion ?? "none"} → ${character.legion ?? "none"}`);
  }
  if (!same(claim.class_name, character.className)) {
    changes.push(`class ${claim.class_name ?? "none"} → ${character.className ?? "none"}`);
  }
  store.updateClaimDetails(claim.discord_id, character);
  const problems = await applyCharacterRoles(member, character);

  return { status: changes.length ? "updated" : "unchanged", claim, changes, problems };
}

function describe(result) {
  const who = `<@${result.claim.discord_id}> **${escapeMarkdown(result.claim.char_name)}**`;
  if (result.status === "updated") return `${who}: ${result.changes.join(", ")}`;
  if (result.status === "review") {
    return `${who}: ${result.alreadyOpen ? "already has an open review case" : `review #${result.caseId}`}`;
  }
  if (result.status === "lookup_failed") return `${who}: ${result.reason}`;
  return who;
}

function listField(name, results) {
  if (results.length === 0) return null;
  const lines = results.slice(0, MAX_LIST_LINES).map(describe);
  if (results.length > MAX_LIST_LINES) lines.push(`…and ${results.length - MAX_LIST_LINES} more`);
  return { name: `${name} (${results.length})`, value: lines.join("\n").slice(0, 1024) };
}

function buildSummary(results, { total, startedAt, startedBy, aborted }) {
  const by = (status) => results.filter((r) => r.status === status);
  const withProblems = results.filter((r) => r.problems?.length);
  const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  const fields = [
    {
      name: "Totals",
      value:
        `Checked ${results.length} of ${total} · unchanged ${by("unchanged").length} · ` +
        `updated ${by("updated").length} · sent to review ${by("review").length} · ` +
        `left the server ${by("left").length} · no longer Verified ${by("not_verified").length} · ` +
        `lookup failed ${by("lookup_failed").length}`,
    },
    listField("Updated", by("updated")),
    listField("Sent to review", by("review")),
    listField("Lookup failed", by("lookup_failed")),
    withProblems.length
      ? {
          name: `Role problems (${withProblems.length})`,
          value: withProblems
            .slice(0, MAX_LIST_LINES)
            .map((r) => `<@${r.claim.discord_id}>: ${r.problems.join("; ")}`)
            .join("\n")
            .slice(0, 1024),
        }
      : null,
  ].filter(Boolean);

  return buildEventEmbed({
    color: aborted ? COLORS.red : by("review").length ? COLORS.yellow : COLORS.green,
    title: aborted ? "Member re-check stopped early" : "Member re-check finished",
    description:
      `Started by <@${startedBy}>, took about ${minutes} min.` +
      (aborted ? `\nStopped after ${MAX_CONSECUTIVE_FAILURES} lookup failures in a row (shugo.gg may be down).` : ""),
    fields,
  });
}

async function runFullRecheck(client, guild, startedBy) {
  const claims = getStore().getAllVerifications();
  running = { startedBy, startedAt: Date.now(), total: claims.length, done: 0 };
  const results = [];
  let consecutiveFailures = 0;
  let aborted = false;

  try {
    for (const claim of claims) {
      let result;
      try {
        result = await recheckClaim(client, guild, claim);
      } catch (error) {
        result = { status: "lookup_failed", claim, reason: error.message };
      }
      results.push(result);
      running.done++;
      consecutiveFailures = result.status === "lookup_failed" ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        aborted = true;
        break;
      }
    }
    await postLog(
      client,
      buildSummary(results, { total: claims.length, startedAt: running.startedAt, startedBy, aborted })
    );
  } finally {
    running = null;
  }
}

module.exports = { recheckClaim, runFullRecheck, getRunningRecheck };
