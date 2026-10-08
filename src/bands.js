// ---------------------------------------------------------------------------
// bands.js - pure functions for band lookup and points. No Discord, no
// database, so this file is easy to test and easy to reason about.
// ---------------------------------------------------------------------------

import { BANDS, LOWEST_ORDER, HIGHEST_ORDER } from "./config.js";

/**
 * The band a score falls into. Top band has no ceiling, bottom band is
 * floored, so every possible score maps to exactly one band.
 */
export function bandForScore(score) {
  // Walk from the top down and return the first band whose lower bound we meet.
  for (let i = BANDS.length - 1; i >= 0; i--) {
    if (score >= BANDS[i].min) return BANDS[i];
  }
  return BANDS[0];
}

/** Band by its order number (1 = lowest). */
export function bandByOrder(order) {
  return BANDS.find((b) => b.order === order) ?? null;
}

/**
 * Which band orders a player is eligible to be matched against.
 *
 *   - Their own band, always.
 *   - One band below, always: a higher-band player may connect with the band
 *     beneath them the moment they open a ticket.
 *   - One band above, but ONLY once the wait has elapsed.
 *
 * Diamond has nothing above it and Bronze has nothing below it, so the range
 * is clamped at both ends.
 */
export function eligibleOrders(myOrder, fallbackOpen) {
  const orders = [myOrder];
  const below = myOrder - 1;
  const above = myOrder + 1;

  if (below >= LOWEST_ORDER) orders.push(below);
  if (fallbackOpen && above <= HIGHEST_ORDER) orders.push(above);

  return orders;
}

/** True when two band orders differ by exactly one - the only legal gap. */
export function isCrossBand(orderA, orderB) {
  return Math.abs(orderA - orderB) === 1;
}

/**
 * Points awarded by a finished match.
 *
 * Returns { winnerDelta, loserDelta } where loserDelta is negative.
 *
 * Same band          -> +win / -loss
 * One band apart     -> the higher-band player risks more than they can win
 *                       (wins the smaller number, loses the larger), and the
 *                       lower-band player gains more than they can lose.
 * Any other gap      -> rejected: matchmaking should never produce one.
 */
export function pointsForResult({ winnerOrder, loserOrder, points }) {
  const gap = Math.abs(winnerOrder - loserOrder);

  if (gap === 0) {
    return { winnerDelta: points.sameWin, loserDelta: -points.sameLoss, kind: "same" };
  }

  if (gap !== 1) {
    throw new Error(
      `Illegal band gap of ${gap} between orders ${winnerOrder} and ${loserOrder}: ` +
        `matches may only be same-band or one band apart.`,
    );
  }

  const winnerWasHigher = winnerOrder > loserOrder;

  if (winnerWasHigher) {
    return {
      winnerDelta: points.higherWins,
      loserDelta: -points.lowerLoses,
      kind: "cross",
      higherPlayerWon: true,
    };
  }

  return {
    winnerDelta: points.lowerWins,
    loserDelta: -points.higherLoses,
    kind: "cross",
    higherPlayerWon: false,
  };
}

/** Apply a delta to a score, honouring the floor. Never returns below floor. */
export function applyDelta(score, delta, floor) {
  return Math.max(floor, score + delta);
}
export const LOWEST_ORDER = BANDS[0].order;
export const HIGHEST_ORDER = BANDS[BANDS.length - 1].order;
