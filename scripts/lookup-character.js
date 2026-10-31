require("dotenv").config({ path: process.env.ENV_FILE, quiet: true });
const { SOURCES, lookupCharacter } = require("../src/verification/lookup");

const COMPARED_FIELDS = ["name", "level", "className", "faction", "server", "legion", "gearScore", "combatPower"];

const args = process.argv.slice(2);
const compare = args.includes("--compare");
const sourceIndex = args.indexOf("--source");
const sourceName = sourceIndex === -1 ? null : args[sourceIndex + 1];
const names = args.filter(
  (arg, index) => !arg.startsWith("--") && (sourceIndex === -1 || index !== sourceIndex + 1)
);

if (names.length === 0 || (sourceName && !SOURCES[sourceName])) {
  console.error(
    "Usage: node scripts/lookup-character.js [--source aion2index|shugo] [--compare] <name> [name...]\n" +
      "  (no flag)  look up like the bot does, following LOOKUP_SOURCES\n" +
      "  --source   ask only that site\n" +
      "  --compare  ask both sites and show fields that differ"
  );
  process.exit(1);
}

function printResult(result) {
  if (result.status !== "found") {
    console.log(result);
    return;
  }
  const { equipment, ...summary } = result.character;
  console.log(summary);
  console.log("equipment:", Object.keys(equipment).join(", ") || "(none from this site)");
}

async function compareSources(name) {
  const [a, b] = await Promise.all([SOURCES.aion2index.lookup(name), SOURCES.shugo.lookup(name)]);
  if (a.status !== "found" || b.status !== "found") {
    console.log("aion2index:", a.status, a.reason ?? "", "| shugo:", b.status, b.reason ?? "");
    return;
  }
  const diffs = COMPARED_FIELDS.filter((field) => a.character[field] !== b.character[field]);
  if (diffs.length === 0) {
    console.log(`same on both sites (characterId ${a.character.characterId})`);
    return;
  }
  for (const field of diffs) {
    console.log(`${field}: aion2index ${a.character[field]} | shugo ${b.character[field]}`);
  }
}

(async () => {
  for (const name of names) {
    const started = Date.now();
    console.log(`\n=== ${name} ===`);
    if (compare) await compareSources(name);
    else if (sourceName) printResult(await SOURCES[sourceName].lookup(name));
    else printResult(await lookupCharacter(name));
    console.log(`(${Date.now() - started} ms)`);
  }
})();
