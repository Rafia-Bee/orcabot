process.env.VERIFY_DB_PATH = ":memory:";
process.env.VERIFY_COOLDOWN_SECONDS = "0";
console.log("Dev mode: fresh in-memory database (nothing is saved), submission cooldown off");
require("../src/bot");
