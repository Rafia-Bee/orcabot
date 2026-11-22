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
    `Usage: node scripts/lookup-character.js [--source ${Object.keys(SOURCES).join("|")}] [--compare] <name> [name...]\n` +
      "  (no flag)  look up like the bot does, following LOOKUP_SOURCES\n" +
      "  --source   ask only that site\n" +
      "  --compare  ask every site and show fields that differ"
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
  const sources = Object.keys(SOURCES);
  const results = await Promise.all(sources.map((source) => SOURCES[source].lookup(name)));
  const found = [];
  sources.forEach((source, index) => {
    const result = results[index];
    if (result.status === "found") found.push({ source, character: result.character });
    else console.log(`${source}: ${result.status} ${result.reason ?? ""}`);
  });
  if (found.length < 2) return;

  const diffs = COMPARED_FIELDS.filter((field) =>
    found.some(({ character }) => character[field] !== found[0].character[field])
  );
  if (diffs.length === 0) {
    console.log(`same on ${found.map(({ source }) => source).join(", ")}`);
    return;
  }
  for (const field of diffs) {
    console.log(`${field}: ${found.map(({ source, character }) => `${source} ${character[field]}`).join(" | ")}`);
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
