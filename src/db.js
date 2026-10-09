// ---------------------------------------------------------------------------
// db.js - SQLite schema and query helpers. All SQL lives here.
//
// The database file must live on a PERSISTENT path. On Railway that means a
// mounted volume - a container filesystem is wiped on every deploy, and with
// it every player, score and match.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import config from "./config.js";
import { bandForScore } from "./bands.js";

// Make sure the directory exists before opening the file.
fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });

const db = new Database(path.resolve(config.databasePath));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    discord_id     TEXT PRIMARY KEY,
    governor_id    TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL,
    start_score    INTEGER NOT NULL,
    points         INTEGER NOT NULL,
    wins           INTEGER NOT NULL DEFAULT 0,
    losses         INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'pending',
    registered_at  INTEGER NOT NULL,
    approved_at    INTEGER,
    approved_by    TEXT
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id   TEXT NOT NULL REFERENCES players(discord_id),
    band_order   INTEGER NOT NULL,
    opened_at    INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    match_id     INTEGER
  );

  -- One open ticket per player, enforced by the database rather than by hope.
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket_per_player
    ON tickets(discord_id) WHERE status = 'open';

  CREATE TABLE IF NOT EXISTS matches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id        TEXT,
    player_a          TEXT NOT NULL REFERENCES players(discord_id),
    player_b          TEXT NOT NULL REFERENCES players(discord_id),
    band_a            INTEGER NOT NULL,
    band_b            INTEGER NOT NULL,
    points_a          INTEGER NOT NULL,
    points_b          INTEGER NOT NULL,
    claim_a           TEXT,
    claim_b           TEXT,
    winner            TEXT,
    resolved_by       TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        INTEGER NOT NULL,
    finished_at       INTEGER
  );

  -- Append-only ledger: every score movement, with the reason. This is the
  -- audit trail and the honest history the spreadsheet cannot give you.
  CREATE TABLE IF NOT EXISTS score_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id    TEXT NOT NULL,
    delta         INTEGER NOT NULL,
    before        INTEGER NOT NULL,
    after         INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    match_id      INTEGER,
    at            INTEGER NOT NULL
  );

  -- Key/value store for things the bot learns at runtime, e.g. the ID of the
  -- match-participant role it creates on first boot.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const now = () => Date.now();

/**
 * Run a function inside a SQLite transaction.
 *
 * This module does not export the raw database instance, so callers in other
 * files (matchmaker.js in particular) must go through this helper rather than
 * calling db.transaction themselves.
 */
/**
 * Reserve a match: create the match row and mark both tickets matched, in one
 * atomic block. Lives here rather than in matchmaker.js because this is the
 * only place with access to the raw SQLite instance.
 *
 * Returns the created match row (with its real id), or throws.
 */
export function reserveMatchRow({ playerA, playerB, bandA, bandB, pointsA, pointsB }) {
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO matches
           (player_a, player_b, band_a, band_b, points_a, points_b, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(playerA, playerB, bandA, bandB, pointsA, pointsB, now());

    // Both tickets move to 'matched' inside the same transaction, so the pair
    // and the ticket states can never disagree.
    db.prepare(
      "UPDATE tickets SET status = 'matched', match_id = ? WHERE discord_id = ? AND status = 'open'",
    ).run(info.lastInsertRowid, playerA);
    db.prepare(
      "UPDATE tickets SET status = 'matched', match_id = ? WHERE discord_id = ? AND status = 'open'",
    ).run(info.lastInsertRowid, playerB);

    return getMatch(info.lastInsertRowid);
  });

  return tx();
}

}

// --- settings --------------------------------------------------------------

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

// --- players ---------------------------------------------------------------

export function getPlayer(discordId) {
  return db.prepare("SELECT * FROM players WHERE discord_id = ?").get(discordId);
}

export function getPlayerByGovernor(governorId) {
  return db.prepare("SELECT * FROM players WHERE governor_id = ?").get(governorId);
}

export function getApprovedPlayer(discordId) {
  const p = getPlayer(discordId);
  return p && p.status === "approved" ? p : null;
}

export function createPlayer({ discordId, governorId, displayName, startScore }) {
  db.prepare(
    `INSERT INTO players
       (discord_id, governor_id, display_name, start_score, points, status, registered_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(discordId, governorId, displayName, startScore, startScore, now());
  return getPlayer(discordId);
}

/**
 * Approve a pending registration and optionally correct the claimed score.
 * Writes a score_history row so the starting score is auditable too.
 */
export function approvePlayer(discordId, approverId, finalScore) {
  const tx = db.transaction(() => {
    const player = getPlayer(discordId);
    if (!player) throw new Error("Player not found.");

    const score = Number.isInteger(finalScore) ? finalScore : player.start_score;

    db.prepare(
      `UPDATE players
          SET status = 'approved', approved_at = ?, approved_by = ?,
              start_score = ?, points = ?
        WHERE discord_id = ?`,
    ).run(now(), approverId, score, score, discordId);

    db.prepare(
      `INSERT INTO score_history (discord_id, delta, before, after, reason, match_id, at)
       VALUES (?, ?, ?, ?, 'placement', NULL, ?)`,
    ).run(discordId, score - player.start_score, player.start_score, score, now());
  });
  tx();
  return getPlayer(discordId);
}

export function denyPlayer(discordId, approverId) {
  db.prepare(
    "UPDATE players SET status = 'denied', approved_at = ?, approved_by = ? WHERE discord_id = ?",
  ).run(now(), approverId, discordId);
}

export function deletePlayer(discordId) {
  db.prepare("DELETE FROM players WHERE discord_id = ?").run(discordId);
}

/** Every approved player, highest points first, with current band attached. */
export function leaderboard(limit = 25) {
  const rows = db
    .prepare(
      `SELECT discord_id, display_name, points, wins, losses
         FROM players
        WHERE status = 'approved'
        ORDER BY points DESC, wins DESC, display_name ASC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map((r, i) => ({ ...r, position: i + 1, band: bandForScore(r.points) }));
}

/** Rank a single player against the whole approved population. */
export function rankOf(discordId) {
  const player = getPlayer(discordId);
  if (!player || player.status !== "approved") return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) + 1 AS position
         FROM players
        WHERE status = 'approved'
          AND (points > ? OR (points = ? AND wins > ?))`,
    )
    .get(player.points, player.points, player.wins);
  return row.position;
}

export function allApprovedPlayers() {
  return db.prepare("SELECT * FROM players WHERE status = 'approved'").all();
}

// --- tickets ---------------------------------------------------------------

export function openTicket(discordId, bandOrder) {
  db.prepare(
    "INSERT INTO tickets (discord_id, band_order, opened_at, status) VALUES (?, ?, ?, 'open')",
  ).run(discordId, bandOrder, now());
  return getOpenTicket(discordId);
}

export function closeTicket(discordId) {
  db.prepare("UPDATE tickets SET status = 'closed' WHERE discord_id = ? AND status = 'open'").run(
    discordId,
  );
}

export function getOpenTicket(discordId) {
  return db.prepare("SELECT * FROM tickets WHERE discord_id = ? AND status = 'open'").get(discordId);
}

/** Every ticket still waiting, oldest first. The matchmaker's work queue. */
export function openTickets(oldestFirst = true) {
  return db
    .prepare(
      `SELECT * FROM tickets WHERE status = 'open' ORDER BY opened_at ${oldestFirst ? "ASC" : "DESC"}`,
    )
    .all();
}

export function markTicketMatched(discordId, matchId) {
  db.prepare(
    "UPDATE tickets SET status = 'matched', match_id = ? WHERE discord_id = ? AND status = 'open'",
  ).run(matchId, discordId);
}

// --- matches ---------------------------------------------------------------

export function createMatch({ channelId, playerA, playerB, bandA, bandB, pointsA, pointsB }) {
  const info = db
    .prepare(
      `INSERT INTO matches
         (channel_id, player_a, player_b, band_a, band_b, points_a, points_b, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(channelId, playerA, playerB, bandA, bandB, pointsA, pointsB, now());
  return getMatch(info.lastInsertRowid);
}

export function getMatch(id) {
  return db.prepare("SELECT * FROM matches WHERE id = ?").get(id);
}

export function getMatchByChannel(channelId) {
  return db
    .prepare("SELECT * FROM matches WHERE channel_id = ? AND status = 'active'")
    .get(channelId);
}

export function getActiveMatchForPlayer(discordId) {
  return db
    .prepare("SELECT * FROM matches WHERE status = 'active' AND (player_a = ? OR player_b = ?)")
    .get(discordId, discordId);
}

/** Record a player's claim. Returns the refreshed match row. */
export function setClaim(matchId, discordId, claimedWinner) {
  const match = getMatch(matchId);
  if (!match) throw new Error("Match not found.");
  const column = match.player_a === discordId ? "claim_a" : "claim_b";
  db.prepare(`UPDATE matches SET ${column} = ? WHERE id = ?`).run(claimedWinner, matchId);
  return getMatch(matchId);
}

export function setMatchStatus(matchId, status, extra = {}) {
  const fields = ["status = ?"];
  const values = [status];
  if (extra.winner !== undefined) {
    fields.push("winner = ?");
    values.push(extra.winner);
  }
  if (extra.resolvedBy !== undefined) {
    fields.push("resolved_by = ?");
    values.push(extra.resolvedBy);
  }
  if (status === "finished" || status === "void") {
    fields.push("finished_at = ?");
    values.push(now());
  }
  values.push(matchId);
  db.prepare(`UPDATE matches SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getMatch(matchId);
}

export function activeMatches() {
  return db.prepare("SELECT * FROM matches WHERE status = 'active'").all();
}

/** Attach the Discord channel to a match once it has been created. */
export function setMatchChannel(matchId, channelId) {
  db.prepare("UPDATE matches SET channel_id = ? WHERE id = ?").run(channelId, matchId);
  return getMatch(matchId);
}

/** Direct point write used by the staff /setpoints command. */
export function setPlayerPoints(discordId, newPoints, actorId) {
  const tx = db.transaction(() => {
    const player = getPlayer(discordId);
    if (!player) throw new Error("Player not found.");
    const before = player.points;
    db.prepare("UPDATE players SET points = ? WHERE discord_id = ?").run(newPoints, discordId);
    db.prepare(
      `INSERT INTO score_history (discord_id, delta, before, after, reason, match_id, at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(discordId, newPoints - before, before, newPoints, `manual:${actorId}`, now());
    return { before, after: newPoints };
  });
  return tx();
}

/** Every player with their status, for the staff /playerlist command. */
export function allPlayersWithStatus() {
  return db
    .prepare(
      "SELECT discord_id, display_name, governor_id, points, status FROM players ORDER BY status, points DESC",
    )
    .all();
}

export function matchHistoryForPlayer(discordId, limit = 10) {
  return db
    .prepare(
      `SELECT * FROM matches
        WHERE status = 'finished' AND (player_a = ? OR player_b = ?)
        ORDER BY finished_at DESC LIMIT ?`,
    )
    .all(discordId, discordId, limit);
}

// --- scoring ---------------------------------------------------------------

/**
 * Apply a finished match atomically: update both players' points, wins and
 * losses, extend the ledger, and close the match. All or nothing.
 */
export function applyMatchResult({ matchId, winnerId, loserId, winnerDelta, loserDelta, reason }) {
  const tx = db.transaction(() => {
    const winner = getPlayer(winnerId);
    const loser = getPlayer(loserId);
    if (!winner || !loser) throw new Error("Player missing when applying result.");

    const winnerBefore = winner.points;
    const loserBefore = loser.points;
    const winnerAfter = Math.max(config.points.floor, winnerBefore + winnerDelta);
    const loserAfter = Math.max(config.points.floor, loserBefore + loserDelta);

    db.prepare("UPDATE players SET points = ?, wins = wins + 1 WHERE discord_id = ?").run(
      winnerAfter,
      winnerId,
    );
    db.prepare("UPDATE players SET points = ?, losses = losses + 1 WHERE discord_id = ?").run(
      loserAfter,
      loserId,
    );

    const ledger = db.prepare(
      `INSERT INTO score_history (discord_id, delta, before, after, reason, match_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ledger.run(winnerId, winnerAfter - winnerBefore, winnerBefore, winnerAfter, reason, matchId, now());
    ledger.run(loserId, loserAfter - loserBefore, loserBefore, loserAfter, reason, matchId, now());

    setMatchStatus(matchId, "finished", { winner: winnerId });

    return { winnerAfter, loserAfter, winnerBefore, loserBefore };
  });
  return tx();
}

export function scoreHistory(discordId, limit = 20) {
  return db
    .prepare("SELECT * FROM score_history WHERE discord_id = ? ORDER BY at DESC LIMIT ?")
    .all(discordId, limit);
}

export default db;
