// ---------------------------------------------------------------------------
// matchmaker.js - pairs open tickets.
//
// The rule, in order:
//   1. Same band first, always.
//   2. If nobody is in your band and you have waited FALLBACK_WAIT_MINUTES,
//      you become eligible for one band ABOVE you.
//   3. One band BELOW you is always eligible, with no wait - a higher-band
//      player can be matched by the band beneath them the moment they queue.
//
// Nothing here reaches above or below one band, ever, and the range clamps at
// Diamond (nothing above) and Bronze (nothing below).
// ---------------------------------------------------------------------------

import config from "./config.js";
import { bandForScore, eligibleOrders, isCrossBand } from "./bands.js";
import * as db from "./db.js";

/**
 * Find a pair to match, or null. Considers every open ticket oldest-first, so
 * whoever queued first gets served first.
 */
export function findPair() {
  const tickets = db.openTickets(true);
  if (tickets.length < 2) return null;

  const now = Date.now();
  const waitMs = config.matchmaking.fallbackWaitMinutes * 60 * 1000;

  // Decorate each ticket with its player and current band (which may have
  // moved since the ticket was opened).
  const queue = [];
  for (const t of tickets) {
    const player = db.getApprovedPlayer(t.discord_id);
    if (!player) continue; // ticket holder is no longer placed; skip
    const band = bandForScore(player.points);
    queue.push({
      ticket: t,
      player,
      band,
      waitedMs: now - t.opened_at,
      fallbackOpen: now - t.opened_at >= waitMs,
    });
  }
  if (queue.length < 2) return null;

  // Earlier position in the queue gets first pick of opponent.
  for (let i = 0; i < queue.length; i++) {
    const seeker = queue[i];
    const seekerOrders = eligibleOrders(seeker.band.order, seeker.fallbackOpen);

    for (let j = 0; j < queue.length; j++) {
      if (i === j) continue;
      const candidate = queue[j];

      // The candidate must be a legal opponent for the seeker.
      if (!seekerOrders.includes(candidate.band.order)) continue;

      // ...and the pairing must be mutual, so nobody is dragged into a match
      // they are not yet eligible for. A same-band pair is always mutual.
      const candidateOrders = eligibleOrders(candidate.band.order, candidate.fallbackOpen);
      if (!candidateOrders.includes(seeker.band.order)) continue;

      // Only same-band or one band apart, by construction, but assert it.
      if (!isCrossBand(seeker.band.order, candidate.band.order)) {
        if (seeker.band.order !== candidate.band.order) continue;
      }

      return { a: seeker, b: candidate };
    }
  }

  return null;
}

/**
 * Pair a seeker and candidate permanently: create the match row and mark both
 * tickets matched. The Discord channel is created by the caller, which has the
 * client. The transaction lives in db.js, which owns the SQLite instance.
 */
export function reserveMatch(a, b) {
  return db.reserveMatchRow({
    playerA: a.player.discord_id,
    playerB: b.player.discord_id,
    bandA: a.band.order,
    bandB: b.band.order,
    pointsA: a.player.points,
    pointsB: b.player.points,
  });
}

/** Attach the created channel to a reserved match. */
export function attachChannel(matchId, channelId) {
  db.setMatchChannel(matchId, channelId);
  return db.getMatch(matchId);
}

/**
 * Describe a ticket's current matchmaking state, for the /queue command.
 */
export function describeQueue() {
  const now = Date.now();
  const waitMs = config.matchmaking.fallbackWaitMinutes * 60 * 1000;
  return db.openTickets(true).map((t) => {
    const player = db.getPlayer(t.discord_id);
    const band = player ? bandForScore(player.points) : null;
    const waited = now - t.opened_at;
    return {
      discordId: t.discord_id,
      name: player ? player.display_name : "(gone)",
      band: band ? band.name : "—",
      waitedMinutes: Math.floor(waited / 60000),
      fallbackOpen: waited >= waitMs,
    };
  });
}
