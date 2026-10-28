const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "orcabot.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verifications (
  discord_id       TEXT PRIMARY KEY,
  char_name        TEXT NOT NULL,
  char_name_lower  TEXT NOT NULL UNIQUE,
  level            INTEGER,
  gear_score       INTEGER,
  combat_power     INTEGER,
  method           TEXT NOT NULL,
  reviewed_by      TEXT,
  created_at       INTEGER NOT NULL
);

DROP TABLE IF EXISTS pending_challenges;

CREATE TABLE IF NOT EXISTS review_cases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id       TEXT NOT NULL,
  char_name        TEXT,
  reason           TEXT NOT NULL,
  character_json   TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  channel_id       TEXT,
  message_id       TEXT,
  resolved_by      TEXT,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX IF NOT EXISTS review_cases_open
  ON review_cases (discord_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS tickets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id       TEXT NOT NULL,
  guild_id         TEXT NOT NULL,
  char_name        TEXT NOT NULL,
  character_json   TEXT,
  reason           TEXT NOT NULL,
  slot             TEXT NOT NULL,
  channel_id       TEXT,
  message_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  resolved_by      TEXT,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX IF NOT EXISTS tickets_open
  ON tickets (discord_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS scheduled_grants (
  discord_id       TEXT PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  char_name        TEXT NOT NULL,
  due_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  discord_id       TEXT PRIMARY KEY,
  next_allowed_at  INTEGER NOT NULL
);
`;

function parseJson(text) {
  return text == null ? null : JSON.parse(text);
}

function rowWithCharacter(row) {
  if (!row) return null;
  const { character_json, ...rest } = row;
  return { ...rest, character: parseJson(character_json) };
}

function openStore(dbPath = process.env.VERIFY_DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const stmt = {
    verificationByDiscordId: db.prepare(
      "SELECT * FROM verifications WHERE discord_id = ?"
    ),
    verificationByCharName: db.prepare(
      "SELECT * FROM verifications WHERE char_name_lower = ?"
    ),
    upsertVerification: db.prepare(`
      INSERT INTO verifications
        (discord_id, char_name, char_name_lower, level, gear_score, combat_power,
         method, reviewed_by, created_at)
      VALUES
        (@discord_id, @char_name, @char_name_lower, @level, @gear_score, @combat_power,
         @method, @reviewed_by, @created_at)
      ON CONFLICT (discord_id) DO UPDATE SET
        char_name = excluded.char_name,
        char_name_lower = excluded.char_name_lower,
        level = excluded.level,
        gear_score = excluded.gear_score,
        combat_power = excluded.combat_power,
        method = excluded.method,
        reviewed_by = excluded.reviewed_by,
        created_at = excluded.created_at
    `),
    deleteVerification: db.prepare(
      "DELETE FROM verifications WHERE discord_id = ?"
    ),

    insertReviewCase: db.prepare(`
      INSERT INTO review_cases (discord_id, char_name, reason, character_json, created_at)
      VALUES (@discord_id, @char_name, @reason, @character_json, @created_at)
      RETURNING *
    `),
    reviewCaseById: db.prepare("SELECT * FROM review_cases WHERE id = ?"),
    openReviewCaseByDiscordId: db.prepare(
      "SELECT * FROM review_cases WHERE discord_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
    ),
    setReviewMessage: db.prepare(
      "UPDATE review_cases SET channel_id = ?, message_id = ? WHERE id = ?"
    ),
    resolveReviewCase: db.prepare(`
      UPDATE review_cases SET status = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'open'
    `),

    insertTicket: db.prepare(`
      INSERT INTO tickets
        (discord_id, guild_id, char_name, character_json, reason, slot, created_at)
      VALUES
        (@discord_id, @guild_id, @char_name, @character_json, @reason, @slot, @created_at)
      RETURNING *
    `),
    ticketById: db.prepare("SELECT * FROM tickets WHERE id = ?"),
    openTicketByDiscordId: db.prepare(
      "SELECT * FROM tickets WHERE discord_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
    ),
    setTicketChannel: db.prepare(
      "UPDATE tickets SET channel_id = ?, message_id = ? WHERE id = ?"
    ),
    resolveTicket: db.prepare(`
      UPDATE tickets SET status = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'open'
    `),
    reopenTicket: db.prepare(
      "UPDATE tickets SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?"
    ),
    deleteTicket: db.prepare("DELETE FROM tickets WHERE id = ?"),

    upsertScheduledGrant: db.prepare(`
      INSERT INTO scheduled_grants (discord_id, guild_id, char_name, due_at)
      VALUES (@discord_id, @guild_id, @char_name, @due_at)
      ON CONFLICT (discord_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        char_name = excluded.char_name,
        due_at = excluded.due_at
    `),
    scheduledGrant: db.prepare(
      "SELECT * FROM scheduled_grants WHERE discord_id = ?"
    ),
    dueGrants: db.prepare(
      "SELECT * FROM scheduled_grants WHERE due_at <= ? ORDER BY due_at"
    ),
    deleteScheduledGrant: db.prepare(
      "DELETE FROM scheduled_grants WHERE discord_id = ?"
    ),

    cooldown: db.prepare(
      "SELECT next_allowed_at FROM cooldowns WHERE discord_id = ?"
    ),
    setCooldown: db.prepare(`
      INSERT INTO cooldowns (discord_id, next_allowed_at) VALUES (?, ?)
      ON CONFLICT (discord_id) DO UPDATE SET next_allowed_at = excluded.next_allowed_at
    `),
    pruneCooldowns: db.prepare("DELETE FROM cooldowns WHERE next_allowed_at <= ?"),
  };

  return {
    db,
    close: () => db.close(),

    getVerification(discordId) {
      return stmt.verificationByDiscordId.get(discordId) ?? null;
    },

    getVerificationByCharName(charName) {
      return stmt.verificationByCharName.get(charName.toLowerCase()) ?? null;
    },

    saveVerification({ discordId, character, method, reviewedBy = null }) {
      const claim = stmt.verificationByCharName.get(character.name.toLowerCase());
      if (claim && claim.discord_id !== discordId) {
        const error = new Error(`${character.name} is already claimed`);
        error.code = "CHAR_CLAIMED";
        error.claimedBy = claim.discord_id;
        throw error;
      }
      stmt.upsertVerification.run({
        discord_id: discordId,
        char_name: character.name,
        char_name_lower: character.name.toLowerCase(),
        level: character.level ?? null,
        gear_score: character.gearScore ?? null,
        combat_power: character.combatPower ?? null,
        method,
        reviewed_by: reviewedBy,
        created_at: Date.now(),
      });
      return this.getVerification(discordId);
    },

    deleteVerification(discordId) {
      return stmt.deleteVerification.run(discordId).changes > 0;
    },

    createReviewCase({ discordId, charName = null, reason, character = null }) {
      return rowWithCharacter(
        stmt.insertReviewCase.get({
          discord_id: discordId,
          char_name: charName,
          reason,
          character_json: character ? JSON.stringify(character) : null,
          created_at: Date.now(),
        })
      );
    },

    getReviewCase(id) {
      return rowWithCharacter(stmt.reviewCaseById.get(id));
    },

    getOpenReviewCase(discordId) {
      return rowWithCharacter(stmt.openReviewCaseByDiscordId.get(discordId));
    },

    setReviewMessage(id, channelId, messageId) {
      stmt.setReviewMessage.run(channelId, messageId, id);
    },

    resolveReviewCase(id, status, resolvedBy) {
      return stmt.resolveReviewCase.run(status, resolvedBy, Date.now(), id).changes > 0;
    },

    createTicket({ discordId, guildId, character, reason, slot }) {
      return rowWithCharacter(
        stmt.insertTicket.get({
          discord_id: discordId,
          guild_id: guildId,
          char_name: character.name,
          character_json: JSON.stringify(character),
          reason,
          slot,
          created_at: Date.now(),
        })
      );
    },

    getTicket(id) {
      return rowWithCharacter(stmt.ticketById.get(id));
    },

    getOpenTicket(discordId) {
      return rowWithCharacter(stmt.openTicketByDiscordId.get(discordId));
    },

    setTicketChannel(id, channelId, messageId) {
      stmt.setTicketChannel.run(channelId, messageId, id);
    },

    resolveTicket(id, status, resolvedBy) {
      return stmt.resolveTicket.run(status, resolvedBy, Date.now(), id).changes > 0;
    },

    reopenTicket(id) {
      stmt.reopenTicket.run(id);
    },

    deleteTicket(id) {
      stmt.deleteTicket.run(id);
    },

    scheduleGrant({ discordId, guildId, charName, dueAt }) {
      stmt.upsertScheduledGrant.run({
        discord_id: discordId,
        guild_id: guildId,
        char_name: charName,
        due_at: dueAt,
      });
    },

    getScheduledGrant(discordId) {
      return stmt.scheduledGrant.get(discordId) ?? null;
    },

    getDueGrants(now = Date.now()) {
      return stmt.dueGrants.all(now);
    },

    deleteScheduledGrant(discordId) {
      return stmt.deleteScheduledGrant.run(discordId).changes > 0;
    },

    getCooldownRemaining(discordId, now = Date.now()) {
      const row = stmt.cooldown.get(discordId);
      return row ? Math.max(0, row.next_allowed_at - now) : 0;
    },

    setCooldown(discordId, durationMs) {
      stmt.setCooldown.run(discordId, Date.now() + durationMs);
    },

    pruneCooldowns(now = Date.now()) {
      stmt.pruneCooldowns.run(now);
    },
  };
}

let sharedStore = null;

function getStore() {
  if (!sharedStore) sharedStore = openStore();
  return sharedStore;
}

module.exports = { openStore, getStore };
