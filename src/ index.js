// ---------------------------------------------------------------------------
// index.js - bot entry point. Wires up the client, the command handlers, the
// button handlers, the matchmaking loop and the monthly leaderboard job.
// ---------------------------------------------------------------------------

import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from "discord.js";
import cron from "node-cron";

import config from "./config.js";
import * as db from "./db.js";
import * as mm from "./matchmaker.js";
import * as svc from "./services.js";
import { colours, leaderboardEmbed, simpleEmbed } from "./embeds.js";
import { commands, handleClaimButton, handleRegistrationButton } from "./commands.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel, Partials.Message],
});

// --- load command handlers -------------------------------------------------

client.commands = new Collection();
for (const cmd of commands) {
  client.commands.set(cmd.data.name, cmd);
}

/** The guild this bot is configured for. */
function configuredGuild() {
  return client.guilds.cache.get(config.guildId) ?? client.guilds.cache.first() ?? null;
}

// --- ready ------------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Guild: ${config.guildId} · DB: ${config.databasePath}`);

  const guild = configuredGuild();
  if (!guild) {
    console.error("Bot is not in the configured guild. Check GUILD_ID and that you invited it.");
    return;
  }

  // Create/verify the participant role on boot so the first match doesn't fail.
  await svc
    .ensureParticipantRole(guild)
    .then((role) => console.log(`Match Participant role: ${role.name} (${role.id})`))
    .catch((err) => console.error("Role setup failed:", err.message));

  // Sanity check the configured channels so problems surface at boot rather
  // than the first time a player needs them.
  for (const [name, id] of Object.entries(config.channels)) {
    const ch = await c.channels.fetch(id).catch(() => null);
    if (!ch) console.error(`Channel ${name} (${id}) could not be fetched. Check the ID and permissions.`);
  }
  for (const [name, id] of Object.entries(config.categories)) {
    if (!id) continue;
    const ch = await c.channels.fetch(id).catch(() => null);
    if (!ch) console.error(`Category ${name} (${id}) could not be fetched.`);
  }

  startMatchmaker();
  startLeaderboardSchedule();

  console.log("Ready.");
});

// --- interactions ----------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      await cmd.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const [prefix] = interaction.customId.split(":");
      if (prefix === "reg") return handleRegistrationButton(interaction);
      if (prefix === "claim") return handleClaimButton(interaction);
      return;
    }
  } catch (err) {
    console.error(
      `Interaction failed [${interaction.customId ?? interaction.commandName}]:`,
      err,
    );

    const payload = {
      embeds: [
        simpleEmbed(
          "Something went wrong handling that. It's been logged — try again, and tell a moderator if it keeps happening.",
          colours.bad,
          "Error",
        ),
      ],
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// --- matchmaking loop ------------------------------------------------------

let matchmakerBusy = false;

function startMatchmaker() {
  const everyMs = Math.max(5, config.matchmaking.tickSeconds) * 1000;
  console.log(
    `Matchmaker running every ${everyMs / 1000}s · fallback wait ${config.matchmaking.fallbackWaitMinutes}m`,
  );

  setInterval(async () => {
    if (matchmakerBusy) return;
    matchmakerBusy = true;
    try {
      // Keep pairing while pairs are available, so a burst of tickets clears
      // in one tick rather than one pair per 20 seconds.
      let guard = 0;
      while (guard++ < 10) {
        const pair = mm.findPair();
        if (!pair) break;

        const guild = configuredGuild();
        if (!guild) break;

        const match = mm.reserveMatch(pair.a, pair.b);
        try {
          const channel = await svc.createMatchChannel(guild, match);
          mm.attachChannel(match.id, channel.id);
          console.log(
            `Match #${match.id}: ${pair.a.player.display_name} (${pair.a.band.name}) vs ` +
              `${pair.b.player.display_name} (${pair.b.band.name}) → #${channel.name}`,
          );
        } catch (err) {
          console.error(`Match #${match.id} created but channel failed:`, err.message);
          await svc.audit(
            guild,
            `Match #${match.id} was paired but the channel failed to create. Investigate.`,
          );
        }
      }
    } catch (err) {
      console.error("Matchmaker tick failed:", err);
    } finally {
      matchmakerBusy = false;
    }
  }, everyMs);
}

// --- monthly leaderboard ---------------------------------------------------

function startLeaderboardSchedule() {
  if (!cron.validate(config.leaderboard.cron)) {
    console.error(`Invalid LEADERBOARD_CRON: "${config.leaderboard.cron}". Monthly post disabled.`);
    return;
  }

  cron.schedule(
    config.leaderboard.cron,
    async () => {
      try {
        const rows = db.leaderboard(config.leaderboard.size);
        const channel = await client.channels
          .fetch(config.channels.leaderboard)
          .catch(() => null);
        if (!channel) {
          console.error("Leaderboard channel unreachable; monthly post skipped.");
          return;
        }
        const month = new Date().toLocaleString("en-GB", {
          month: "long",
          year: "numeric",
          timeZone: config.leaderboard.timezone,
        });
        await channel.send({
          embeds: [leaderboardEmbed({ rows, title: `Ladder standings — ${month}` })],
        });
        console.log(`Monthly leaderboard posted (${month}).`);
      } catch (err) {
        console.error("Monthly leaderboard failed:", err);
      }
    },
    { timezone: config.leaderboard.timezone },
  );

  console.log(
    `Monthly leaderboard scheduled: "${config.leaderboard.cron}" (${config.leaderboard.timezone}) · top ${config.leaderboard.size}`,
  );
}

// --- login -----------------------------------------------------------------

client.login(config.token).catch((err) => {
  console.error("Login failed:", err.message);
  console.error("Check DISCORD_TOKEN, and that the bot was invited with the right scopes.");
  process.exit(1);
});

// --- graceful shutdown -----------------------------------------------------

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received. Closing database and exiting.`);
    try {
      db.default.close();
    } catch {
      // already closed
    }
    client.destroy();
    process.exit(0);
  });
}
