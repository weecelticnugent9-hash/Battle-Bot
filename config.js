// ---------------------------------------------------------------------------
// config.js - reads every setting from the environment, validates it, and
// exports one frozen config object. Nothing else in the bot reads process.env.
// ---------------------------------------------------------------------------

import "dotenv/config";

/** Read a required string, throwing a clear error if it is missing. */
function required(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Add it to your .env file locally, or to the Variables tab on Railway.`,
    );
  }
  return String(v).trim();
}

/** Read an optional string, returning "" when unset. */
function optional(name) {
  const v = process.env[name];
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Read an integer with a default, throwing if the value is not a number. */
function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be a whole number, got "${raw}".`);
  }
  return n;
}

const BAND_DIAMOND = int("BAND_DIAMOND", 2700);
const BAND_GOLD = int("BAND_GOLD", 2300);
const BAND_SILVER = int("BAND_SILVER", 2000);
const BAND_BRONZE_II = int("BAND_BRONZE_II", 1700);

// Sanity: thresholds must strictly descend, or band lookup is ambiguous.
const thresholds = [BAND_DIAMOND, BAND_GOLD, BAND_SILVER, BAND_BRONZE_II];
for (let i = 1; i < thresholds.length; i++) {
  if (thresholds[i] >= thresholds[i - 1]) {
    throw new Error(
      `Band thresholds must descend: BAND_DIAMOND > BAND_GOLD > BAND_SILVER > BAND_BRONZE_II. ` +
        `Got ${thresholds.join(", ")}.`,
    );
  }
}

/**
 * Bands, lowest first. `order` is what matchmaking uses for "one band up or
 * down"; `min` is the inclusive lower bound of the band in points.
 * The top band has no ceiling; the bottom band bottoms out at SCORE_FLOOR.
 */
export const BANDS = [
  { key: "bronze", name: "Bronze", order: 1, min: int("SCORE_FLOOR", 1) },
  { key: "bronze_ii", name: "Bronze II", order: 2, min: BAND_BRONZE_II },
  { key: "silver", name: "Silver", order: 3, min: BAND_SILVER },
  { key: "gold", name: "Gold", order: 4, min: BAND_GOLD },
  { key: "diamond", name: "Diamond", order: 5, min: BAND_DIAMOND },
];

export const LOWEST_ORDER = BANDS[0].order;
export const HIGHEST_ORDER = BANDS[BANDS.length - 1].order;

const config = {
  token: required("DISCORD_TOKEN"),
  clientId: required("CLIENT_ID"),
  guildId: required("GUILD_ID"),

  channels: {
    staffApprovals: required("CHANNEL_STAFF_APPROVALS"),
    leaderboard: required("CHANNEL_LEADERBOARD"),
    tickets: required("CHANNEL_TICKETS"),
  },

  categories: {
    matches: required("CATEGORY_MATCHES"),
    tickets: optional("CATEGORY_TICKETS"),
  },

  roles: {
    staff: required("ROLE_STAFF"),
    matchParticipant: optional("ROLE_MATCH_PARTICIPANT"),
  },

  points: {
    sameWin: int("POINTS_SAME_WIN", 50),
    sameLoss: int("POINTS_SAME_LOSS", 50),
    higherWins: int("POINTS_HIGHER_WINS", 25),
    higherLoses: int("POINTS_HIGHER_LOSES", 75),
    lowerWins: int("POINTS_LOWER_WINS", 75),
    lowerLoses: int("POINTS_LOWER_LOSES", 25),
    floor: int("SCORE_FLOOR", 1),
  },

  matchmaking: {
    fallbackWaitMinutes: int("FALLBACK_WAIT_MINUTES", 30),
    tickSeconds: int("MATCHMAKER_TICK_SECONDS", 20),
  },

  leaderboard: {
    cron: optional("LEADERBOARD_CRON") || "0 9 1 * *",
    timezone: optional("TIMEZONE") || "Europe/London",
    size: int("LEADERBOARD_SIZE", 25),
  },

  databasePath: optional("DATABASE_PATH") || "./data/battles.db",
};

export default config;
