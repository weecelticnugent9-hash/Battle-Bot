// ---------------------------------------------------------------------------
// register-commands.js - one-off script that publishes the slash commands to
// your guild. Run with:  npm run register-commands
//
// Guild commands appear instantly (global ones can take an hour), which is why
// this uses GUILD_ID.
// ---------------------------------------------------------------------------

import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import config from "./config.js";

const commands = [
  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Join the ladder. Needs your governor ID and your Mystic Trials score.")
    .addStringOption((o) =>
      o.setName("governor_id").setDescription("Your in-game governor ID, e.g. 66023654").setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("trials_score")
        .setDescription("Your Mystic Trials score, e.g. 2232")
        .setRequired(true)
        .setMinValue(1),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("See your ladder card: points, band, rank and record.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("battle")
    .setDescription("Open a ticket and get matched with an opponent.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Withdraw your open ticket.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show who is waiting for a match right now.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Post the current standings.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("Your recent matches and score movements.")
    .toJSON(),

  // --- staff commands ---
  new SlashCommandBuilder()
    .setName("approve")
    .setDescription("(Staff) Approve a player's placement.")
    .addUserOption((o) => o.setName("player").setDescription("The player to approve").setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName("score")
        .setDescription("Override the starting score, if their claim is wrong")
        .setRequired(false)
        .setMinValue(1),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("deny")
    .setDescription("(Staff) Reject a placement request.")
    .addUserOption((o) => o.setName("player").setDescription("The player to reject").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("(Staff) Set the official winner of a disputed match.")
    .addIntegerOption((o) => o.setName("match_id").setDescription("The match ID").setRequired(true))
    .addUserOption((o) => o.setName("winner").setDescription("Who actually won").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("setpoints")
    .setDescription("(Staff) Correct a player's points.")
    .addUserOption((o) => o.setName("player").setDescription("The player").setRequired(true))
    .addIntegerOption((o) => o.setName("points").setDescription("Their new points total").setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("playerlist")
    .setDescription("(Staff) List every placed player with their status.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),
].map((c) => c);

const rest = new REST({ version: "10" }).setToken(config.token);

try {
  console.log(`Publishing ${commands.length} commands to guild ${config.guildId}...`);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log("Done. Commands are live in your server now.");
} catch (err) {
  console.error("Failed to publish commands:", err);
  process.exitCode = 1;
}
