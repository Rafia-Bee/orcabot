require("dotenv").config({ path: process.env.ENV_FILE, quiet: true });
const { getConfig } = require("../src/verification/config");
const { getStore } = require("../src/verification/store");
const aion2index = require("../src/verification/sources/aion2index");

const MAX_CONSECUTIVE_FAILURES = 5;
const write = process.argv.includes("--write");

function same(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

function mismatch(claim, character) {
  const cfg = getConfig();
  if (claim.class_name && !same(claim.class_name, character.className)) {
    return `class was ${claim.class_name}, now ${character.className}`;
  }
  if (!same(character.faction, cfg.requiredFaction)) return `faction is ${character.faction}`;
  if (!same(character.server, cfg.requiredServer)) return `server is ${character.server}`;
  return null;
}

(async () => {
  if (!getConfig().aion2index.apiKey) {
    console.error("AION2INDEX_API_KEY is empty. Add it to .env first.");
    process.exit(1);
  }

  const store = getStore();
  const claims = store.getAllVerifications().filter((claim) => !claim.character_id);
  const minutes = Math.ceil((claims.length * aion2index.minRequestGapMs()) / 60_000);
  console.log(
    `${claims.length} verified member(s) without a characterId. About ${minutes} min.` +
      (write ? "" : " Dry run: nothing is saved. Add --write to save.")
  );

  const report = { saved: [], notFound: [], skipped: [], failed: [] };
  let consecutiveFailures = 0;

  for (const [index, claim] of claims.entries()) {
    const label = `${claim.char_name} (${claim.discord_id})`;
    const result = await aion2index.lookup(claim.char_name, { allowStale: true });
    process.stdout.write(`\r${index + 1}/${claims.length}`);

    if (result.status === "unavailable") {
      report.failed.push(`${label}: ${result.reason}`);
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`\nStopped after ${MAX_CONSECUTIVE_FAILURES} failed lookups in a row.`);
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    if (result.status === "not_found") {
      report.notFound.push(label);
      continue;
    }

    const character = result.character;
    const problem = mismatch(claim, character);
    if (problem) {
      report.skipped.push(`${label}: ${problem}`);
      continue;
    }
    const owner = store.getVerificationByCharacterId(character.characterId);
    if (owner) {
      report.skipped.push(`${label}: characterId already belongs to ${owner.char_name} (${owner.discord_id})`);
      continue;
    }
    if (write) store.setCharacterId(claim.discord_id, character.characterId);
    report.saved.push(`${label} → ${character.characterId}`);
  }

  console.log("\n");
  const sections = [
    [write ? "Saved" : "Would save", report.saved],
    ["Not found (renamed or deleted; /recheck-members sends these to review)", report.notFound],
    ["Skipped (check by hand)", report.skipped],
    ["Lookup failed (run the script again to retry these)", report.failed],
  ];
  for (const [title, lines] of sections) {
    console.log(`${title}: ${lines.length}`);
    for (const line of lines) console.log(`  ${line}`);
  }
  store.close();
})();
