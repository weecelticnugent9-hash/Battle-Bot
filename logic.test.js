// ---------------------------------------------------------------------------
// test/logic.test.js - a plain-node test harness for the pure ladder logic.
// No test framework needed: run "node test/logic.test.js".
// The band and points rules are reimplemented here inline so this file runs on
// its own (the bot's src/ file uses ESM plus a config import that needs env).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";

// --- the rules, mirrored from src/bands.js + src/config.js defaults --------

const BANDS = [
  { key: "bronze", name: "Bronze", order: 1, min: 1 },
  { key: "bronze_ii", name: "Bronze II", order: 2, min: 1700 },
  { key: "silver", name: "Silver", order: 3, min: 2000 },
  { key: "gold", name: "Gold", order: 4, min: 2300 },
  { key: "diamond", name: "Diamond", order: 5, min: 2700 },
];
const LOWEST_ORDER = 1;
const HIGHEST_ORDER = 5;

function bandForScore(score) {
  for (let i = BANDS.length - 1; i >= 0; i--) {
    if (score >= BANDS[i].min) return BANDS[i];
  }
  return BANDS[0];
}

function eligibleOrders(myOrder, fallbackOpen) {
  const orders = [myOrder];
  const below = myOrder - 1;
  const above = myOrder + 1;
  if (below >= LOWEST_ORDER) orders.push(below);
  if (fallbackOpen && above <= HIGHEST_ORDER) orders.push(above);
  return orders;
}

function isCrossBand(a, b) {
  return Math.abs(a - b) === 1;
}

const points = {
  sameWin: 50, sameLoss: 50,
  higherWins: 25, higherLoses: 75,
  lowerWins: 75, lowerLoses: 25,
  floor: 1,
};

function pointsForResult({ winnerOrder, loserOrder, points: p }) {
  const gap = Math.abs(winnerOrder - loserOrder);
  if (gap === 0) return { winnerDelta: p.sameWin, loserDelta: -p.sameLoss, kind: "same" };
  if (gap !== 1) throw new Error(`Illegal band gap of ${gap}`);
  if (winnerOrder > loserOrder) {
    return { winnerDelta: p.higherWins, loserDelta: -p.lowerLoses, kind: "cross", higherPlayerWon: true };
  }
  return { winnerDelta: p.lowerWins, loserDelta: -p.higherLoses, kind: "cross", higherPlayerWon: false };
}

function applyDelta(score, delta, floor) {
  return Math.max(floor, score + delta);
}

// --- harness --------------------------------------------------------------

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

console.log("\nband lookup");
test("2232 is Silver", () => assert.equal(bandForScore(2232).name, "Silver"));
test("2250 is Silver", () => assert.equal(bandForScore(2250).name, "Silver"));
test("2300 is Gold (threshold inclusive)", () => assert.equal(bandForScore(2300).name, "Gold"));
test("2299 is Silver", () => assert.equal(bandForScore(2299).name, "Silver"));
test("2700 is Diamond", () => assert.equal(bandForScore(2700).name, "Diamond"));
test("3400 is still Diamond (no ceiling)", () => assert.equal(bandForScore(3400).name, "Diamond"));
test("1700 is Bronze II", () => assert.equal(bandForScore(1700).name, "Bronze II"));
test("1699 is Bronze", () => assert.equal(bandForScore(1699).name, "Bronze"));
test("2000 is Silver", () => assert.equal(bandForScore(2000).name, "Silver"));
test("1 is Bronze (floor)", () => assert.equal(bandForScore(1).name, "Bronze"));

console.log("\neligible opponents");
test("Silver, fallback closed: Bronze II + Silver", () => assert.deepEqual(eligibleOrders(3, false).sort(), [2, 3]));
test("Silver, fallback open: Bronze II + Silver + Gold", () => assert.deepEqual(eligibleOrders(3, true).sort(), [2, 3, 4]));
test("Bronze has nothing below - orders 1 and 2 only", () => assert.deepEqual(eligibleOrders(1, true).sort(), [1, 2]));
test("Diamond has nothing above - orders 4 and 5 only", () => assert.deepEqual(eligibleOrders(5, true).sort(), [4, 5]));
test("never reaches two bands", () => {
  const o = eligibleOrders(3, true);
  assert.ok(!o.includes(1), "Silver must not reach Bronze");
  assert.ok(!o.includes(5), "Silver must not reach Diamond");
});

console.log("\nband gap");
test("same band is not cross-band", () => assert.equal(isCrossBand(3, 3), false));
test("one apart is cross-band", () => assert.equal(isCrossBand(3, 4), true));
test("two apart is illegal", () => assert.equal(isCrossBand(3, 5), false));

console.log("\npoints - same band");
test("same band: +50 / -50", () => {
  const r = pointsForResult({ winnerOrder: 3, loserOrder: 3, points });
  assert.equal(r.winnerDelta, 50); assert.equal(r.loserDelta, -50);
});

console.log("\npoints - cross band, higher player wins");
test("higher wins: higher +25, lower -25", () => {
  const r = pointsForResult({ winnerOrder: 4, loserOrder: 3, points });
  assert.equal(r.winnerDelta, 25);
  assert.equal(r.loserDelta, -25);
  assert.equal(r.higherPlayerWon, true);
});

console.log("\npoints - cross band, lower player wins");
test("lower wins: lower +75, higher -75", () => {
  const r = pointsForResult({ winnerOrder: 3, loserOrder: 4, points });
  assert.equal(r.winnerDelta, 75);
  assert.equal(r.loserDelta, -75);
  assert.equal(r.higherPlayerWon, false);
});

test("the handicap: higher band risks 75 to win 25", () => {
  const asWinner = pointsForResult({ winnerOrder: 4, loserOrder: 3, points });
  const asLoser = pointsForResult({ winnerOrder: 3, loserOrder: 4, points });
  assert.equal(asWinner.winnerDelta, 25);
  assert.equal(asLoser.loserDelta, -75);
});

test("illegal two-band gap is rejected", () => {
  assert.throws(() => pointsForResult({ winnerOrder: 5, loserOrder: 3, points }), /Illegal band gap/);
});

console.log("\nscore floor");
test("30 points losing 50 floors at 1", () => assert.equal(applyDelta(30, -50, 1), 1));
test("1 point losing 75 stays at 1", () => assert.equal(applyDelta(1, -75, 1), 1));
test("normal loss unaffected: 2232 - 50 = 2182", () => assert.equal(applyDelta(2232, -50, 1), 2182));

console.log("\nthe two test players");
test("ConnerNugent 2232 loses to toymonster 2250 -> 2182", () => {
  const r = pointsForResult({ winnerOrder: 3, loserOrder: 3, points });
  assert.equal(applyDelta(2232, r.loserDelta, 1), 2182);
});
test("toymonster 2250 wins -> 2300, now Gold", () => {
  const r = pointsForResult({ winnerOrder: 3, loserOrder: 3, points });
  const after = applyDelta(2250, r.winnerDelta, 1);
  assert.equal(after, 2300);
  assert.equal(bandForScore(after).name, "Gold");
});
test("rematch: ConnerNugent (Silver 2182) beats toymonster (Gold 2300) -> 2257 / 2225", () => {
  const r = pointsForResult({ winnerOrder: 3, loserOrder: 4, points });
  assert.equal(applyDelta(2182, r.winnerDelta, 1), 2257);
  assert.equal(applyDelta(2300, r.loserDelta, 1), 2225);
  assert.equal(bandForScore(2225).name, "Silver");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
