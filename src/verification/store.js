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
  legion           TEXT,
  class_name       TEXT,
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

CREATE TABLE IF NOT EXISTS bot_state (
  key              TEXT PRIMARY KEY,
  value            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeslot_boards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  raid_event_id    TEXT NOT NULL,
  title            TEXT NOT NULL,
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT,
  event_start      INTEGER NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS timeslots (
  board_id         INTEGER NOT NULL,
  slot_index       INTEGER NOT NULL,
  starts_at        INTEGER NOT NULL,
  ends_at          INTEGER NOT NULL,
  user_id          TEXT,
  reminded_at      INTEGER,
  reminder_message_id TEXT,
  done_at          INTEGER,
  PRIMARY KEY (board_id, slot_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS timeslots_one_per_user
  ON timeslots (board_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_timezones (
  user_id          TEXT PRIMARY KEY,
  time_zone        TEXT NOT NULL
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
  const verificationColumns = db.prepare("PRAGMA table_info(verifications)").all().map((c) => c.name);
  for (const column of ["legion", "class_name", "character_id"]) {
    if (!verificationColumns.includes(column)) {
      db.exec(`ALTER TABLE verifications ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS verifications_character_id
      ON verifications (character_id) WHERE character_id IS NOT NULL
  `);

  const stmt = {
    verificationByDiscordId: db.prepare(
      "SELECT * FROM verifications WHERE discord_id = ?"
    ),
    verificationByCharName: db.prepare(
      "SELECT * FROM verifications WHERE char_name_lower = ?"
    ),
    verificationByCharacterId: db.prepare(
      "SELECT * FROM verifications WHERE character_id = ?"
    ),
    upsertVerification: db.prepare(`
      INSERT INTO verifications
        (discord_id, char_name, char_name_lower, character_id, level, gear_score, combat_power, legion,
         class_name, method, reviewed_by, created_at)
      VALUES
        (@discord_id, @char_name, @char_name_lower, @character_id, @level, @gear_score, @combat_power, @legion,
         @class_name, @method, @reviewed_by, @created_at)
      ON CONFLICT (discord_id) DO UPDATE SET
        char_name = excluded.char_name,
        character_id = excluded.character_id,
        char_name_lower = excluded.char_name_lower,
        level = excluded.level,
        gear_score = excluded.gear_score,
        combat_power = excluded.combat_power,
        legion = excluded.legion,
        class_name = excluded.class_name,
        method = excluded.method,
        reviewed_by = excluded.reviewed_by,
        created_at = excluded.created_at
    `),
    allVerifications: db.prepare("SELECT * FROM verifications ORDER BY created_at"),
    updateClaimDetails: db.prepare(`
      UPDATE verifications SET
        char_name = @char_name, char_name_lower = @char_name_lower,
        character_id = COALESCE(@character_id, character_id), level = @level,
        gear_score = @gear_score, combat_power = @combat_power, legion = @legion, class_name = @class_name
      WHERE discord_id = @discord_id
    `),
    setCharacterId: db.prepare(
      "UPDATE verifications SET character_id = ? WHERE discord_id = ?"
    ),
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

    state: db.prepare("SELECT value FROM bot_state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO bot_state (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `),

    insertTimeslotBoard: db.prepare(`
      INSERT INTO timeslot_boards (raid_event_id, title, guild_id, channel_id, event_start, created_by, created_at)
      VALUES (@raid_event_id, @title, @guild_id, @channel_id, @event_start, @created_by, @created_at)
      RETURNING *
    `),
    insertTimeslot: db.prepare(`
      INSERT INTO timeslots (board_id, slot_index, starts_at, ends_at, user_id)
      SELECT ?, COALESCE(MAX(slot_index), -1) + 1, ?, ?, ? FROM timeslots WHERE board_id = ?
    `),
    startedTimeslotForUser: db.prepare(
      "SELECT 1 FROM timeslots WHERE board_id = ? AND user_id = ? AND reminded_at IS NOT NULL"
    ),
    timeslotBoardById: db.prepare("SELECT * FROM timeslot_boards WHERE id = ?"),
    openTimeslotBoardForEvent: db.prepare(
      "SELECT * FROM timeslot_boards WHERE raid_event_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
    ),
    openTimeslotBoards: db.prepare("SELECT * FROM timeslot_boards WHERE status = 'open' ORDER BY id"),
    setTimeslotBoardMessage: db.prepare("UPDATE timeslot_boards SET message_id = ? WHERE id = ?"),
    closeTimeslotBoard: db.prepare(
      "UPDATE timeslot_boards SET status = 'closed' WHERE id = ? AND status = 'open'"
    ),
    timeslots: db.prepare(
      "SELECT * FROM timeslots WHERE board_id = ? AND user_id IS NOT NULL ORDER BY starts_at, slot_index"
    ),
    releaseTimeslot: db.prepare(
      "DELETE FROM timeslots WHERE board_id = ? AND user_id = ? AND reminded_at IS NULL"
    ),
    markTimeslotReminded: db.prepare(
      "UPDATE timeslots SET reminded_at = ?, reminder_message_id = ? WHERE board_id = ? AND slot_index = ?"
    ),
    markTimeslotDone: db.prepare(
      "UPDATE timeslots SET done_at = ? WHERE board_id = ? AND slot_index = ? AND done_at IS NULL"
    ),
    userTimeZone: db.prepare("SELECT time_zone FROM user_timezones WHERE user_id = ?"),
    setUserTimeZone: db.prepare(`
      INSERT INTO user_timezones (user_id, time_zone) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET time_zone = excluded.time_zone
    `),
  };

  const pickTimeslot = db.transaction((boardId, userId, startsAt, endsAt) => {
    if (stmt.startedTimeslotForUser.get(boardId, userId)) return false;
    stmt.releaseTimeslot.run(boardId, userId);
    stmt.insertTimeslot.run(boardId, startsAt, endsAt, userId, boardId);
    return true;
  });

  return {
    db,
    close: () => db.close(),

    getVerification(discordId) {
      return stmt.verificationByDiscordId.get(discordId) ?? null;
    },

    getVerificationByCharName(charName) {
      return stmt.verificationByCharName.get(charName.toLowerCase()) ?? null;
    },

    getVerificationByCharacterId(characterId) {
      return characterId ? stmt.verificationByCharacterId.get(characterId) ?? null : null;
    },

    getVerificationForCharacter(character) {
      return (
        this.getVerificationByCharacterId(character.characterId) ??
        this.getVerificationByCharName(character.name)
      );
    },

    saveVerification({ discordId, character, method, reviewedBy = null }) {
      const claims = [
        this.getVerificationByCharacterId(character.characterId),
        this.getVerificationByCharName(character.name),
      ];
      const other = claims.find((claim) => claim && claim.discord_id !== discordId);
      if (other) {
        const error = new Error(`${character.name} is already claimed`);
        error.code = "CHAR_CLAIMED";
        error.claimedBy = other.discord_id;
        throw error;
      }
      const own = this.getVerification(discordId);
      const keptCharacterId =
        own && own.char_name_lower === character.name.toLowerCase() ? own.character_id : null;
      stmt.upsertVerification.run({
        discord_id: discordId,
        char_name: character.name,
        char_name_lower: character.name.toLowerCase(),
        character_id: character.characterId ?? keptCharacterId,
        level: character.level ?? null,
        gear_score: character.gearScore ?? null,
        combat_power: character.combatPower ?? null,
        legion: character.legion ?? null,
        class_name: character.className ?? null,
        method,
        reviewed_by: reviewedBy,
        created_at: Date.now(),
      });
      return this.getVerification(discordId);
    },

    deleteVerification(discordId) {
      return stmt.deleteVerification.run(discordId).changes > 0;
    },

    getAllVerifications() {
      return stmt.allVerifications.all();
    },

    updateClaimDetails(discordId, character) {
      stmt.updateClaimDetails.run({
        discord_id: discordId,
        char_name: character.name,
        char_name_lower: character.name.toLowerCase(),
        character_id: character.characterId ?? null,
        level: character.level ?? null,
        gear_score: character.gearScore ?? null,
        combat_power: character.combatPower ?? null,
        legion: character.legion ?? null,
        class_name: character.className ?? null,
      });
    },

    setCharacterId(discordId, characterId) {
      return stmt.setCharacterId.run(characterId, discordId).changes > 0;
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

    getState(key) {
      return stmt.state.get(key)?.value ?? null;
    },

    setState(key, value) {
      stmt.setState.run(key, String(value));
    },

    createTimeslotBoard({ raidEventId, title, guildId, channelId, eventStart, createdBy }) {
      return stmt.insertTimeslotBoard.get({
        raid_event_id: raidEventId,
        title,
        guild_id: guildId,
        channel_id: channelId,
        event_start: eventStart,
        created_by: createdBy,
        created_at: Date.now(),
      });
    },

    getTimeslotBoard(id) {
      return stmt.timeslotBoardById.get(id) ?? null;
    },

    getOpenTimeslotBoardForEvent(raidEventId) {
      return stmt.openTimeslotBoardForEvent.get(raidEventId) ?? null;
    },

    getOpenTimeslotBoards() {
      return stmt.openTimeslotBoards.all();
    },

    setTimeslotBoardMessage(id, messageId) {
      stmt.setTimeslotBoardMessage.run(messageId, id);
    },

    closeTimeslotBoard(id) {
      return stmt.closeTimeslotBoard.run(id).changes > 0;
    },

    getTimeslots(boardId) {
      return stmt.timeslots.all(boardId);
    },

    pickTimeslot(boardId, userId, startsAt, endsAt) {
      return pickTimeslot(boardId, userId, startsAt, endsAt);
    },

    releaseTimeslot(boardId, userId) {
      return stmt.releaseTimeslot.run(boardId, userId).changes > 0;
    },

    markTimeslotReminded(boardId, slotIndex, messageId, now = Date.now()) {
      stmt.markTimeslotReminded.run(now, messageId, boardId, slotIndex);
    },

    markTimeslotDone(boardId, slotIndex, now = Date.now()) {
      return stmt.markTimeslotDone.run(now, boardId, slotIndex).changes > 0;
    },

    getUserTimeZone(userId) {
      return stmt.userTimeZone.get(userId)?.time_zone ?? null;
    },

    setUserTimeZone(userId, timeZone) {
      stmt.setUserTimeZone.run(userId, timeZone);
    },
  };
}

let sharedStore = null;

function getStore() {
  if (!sharedStore) sharedStore = openStore();
  return sharedStore;
}

module.exports = { openStore, getStore };
