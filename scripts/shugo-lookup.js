require("dotenv").config();
const { lookupCharacter } = require("../src/verification/shugo");

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("Usage: node scripts/shugo-lookup.js <name> [name...]");
  process.exit(1);
}

(async () => {
  for (const name of names) {
    const started = Date.now();
    const result = await lookupCharacter(name);
    console.log(`\n=== ${name} (${Date.now() - started} ms) ===`);
    if (result.status !== "found") {
      console.log(result);
      continue;
    }
    const { equipment, ...summary } = result.character;
    console.log(summary);
    console.log("equipment:", Object.keys(equipment).join(", "));
    console.log("belt:", equipment.Belt ?? "(empty)");
    console.log(
      "equipment updated:",
      new Date(summary.equipmentUpdatedAt).toISOString()
    );
  }
})();
