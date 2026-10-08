// ---------------------------------------------------------------------------
// commands.js - every slash command handler, plus the button handlers.
// ---------------------------------------------------------------------------

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import config from "./config.js";
import { bandForScore, HIGHEST_ORDER, LOWEST_ORDER, pointsForResult } from "./bands.js";
import * as db from "./db.js";
import * as mm from "./matchmaker.js";
import * as svc from "./services.js";
import {
  colours,
  disputeEmbed,
  leaderboardEmbed,
  playerCardEmbed,
  registrationEmbed,
  simpleEmbed,
} from "./embeds.js";

// --- helpers ---------------------------------------------------------------

async function reply(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply(payload);
}

async function ephemeral(interaction, description, colour = colours.neutral, title = null) {
  const payload = { embeds: [simpleEmbed(description, colour, title)], flags: MessageFlags.Ephemeral };
  return reply(interaction, payload);
}

export function isStaff(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return true;
  const member = interaction.member;
  return Boolean(member?.roles?.cache?.has(config.roles.staff));
}

/** The player row, or null with an explanatory reply already sent. */
async function requirePlacedPlayer(interaction) {
  const player = db.getPlayer(interaction.user.id);
  if (!player) {
    await ephemeral(
      interaction,
      "You're not registered yet. Use `/register` with your governor ID and Mystic Trials score, then wait for a moderator to approve you.",
      colours.warn,
      "Not registered",
    );
    return null;
  }
  if (player.status === "pending") {
    await ephemeral(
      interaction,
      "Your placement is still waiting on a moderator. You can't be matched until you're approved.",
      colours.warn,
      "Awaiting approval",
    );
    return null;
  }
  if (player.status === "denied") {
    await ephemeral(interaction, "Your placement request was declined. Speak to a moderator.", colours.bad, "Not placed");
    return null;
  }
  return player;
}

// --- /register -------------------------------------------------------------

export const register = {
  data: new SlashCommandBuilder()
    .setName("register")
    .setDescription("Join the ladder. Needs your governor ID and your Mystic Trials score.")
    .addStringOption((o) =>
      o.setName("governor_id").setDescription("Your in-game governor ID, e.g. 66023654").setRequired(true),
    )
    .addIntegerOption((o) =>
      o.setName("trials_score").setDescription("Your Mystic Trials score, e.g. 2232").setRequired(true).setMinValue(1),
    ),

  async execute(interaction) {
    const governorId = interaction.options.getString("governor_id").trim();
    const trialsScore = interaction.options.getInteger("trials_score");

    if (!/^\d{4,20}$/.test(governorId)) {
      return ephemeral(
        interaction,
        "That doesn't look like a governor ID. It should be digits only â the number the game shows on your profile.",
        colours.bad,
        "Check your governor ID",
      );
    }

    const existing = db.getPlayer(interaction.user.id);
    if (existing) {
      return ephemeral(
        interaction,
        existing.status === "approved"
          ? `You're already placed with ${existing.points} points. Use \`/profile\` to see your card.`
          : `You already have a registration \`${existing.status}\`. A moderator will get to it.`,
        colours.warn,
        "Already registered",
      );
    }

    const clash = db.getPlayerByGovernor(governorId);
    if (clash) {
      // This is the farming-prevention rule: one governor ID, one account.
      return ephemeral(
        interaction,
        "That governor ID is already linked to another Discord account. If that's a mistake, ask a moderator to sort it out.",
        colours.bad,
        "Governor ID already linked",
      );
    }

    const player = db.createPlayer({
      discordId: interaction.user.id,
      governorId,
      displayName: interaction.member?.displayName ?? interaction.user.username,
      startScore: trialsScore,
    });

    // Post to staff with approve/deny buttons.
    const staffChannel = await interaction.client.channels
      .fetch(config.channels.staffApprovals)
      .catch(() => null);

    if (!staffChannel) {
      return ephemeral(
        interaction,
        "I couldn't reach the staff channel, so your request wasn't submitted. Tell a moderator to check the channel ID in my config.",
        colours.bad,
        "Staff channel unreachable",
      );
    }

    await staffChannel.send({
      embeds: [registrationEmbed({ player, user: interaction.user })],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`reg:approve:${player.discord_id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`reg:deny:${player.discord_id}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
        ),
      ],
    });

    return ephemeral(
      interaction,
      `Submitted. Your claimed Mystic Trials score is **${trialsScore}**, which would place you in **${bandForScore(trialsScore).name}**. A moderator will approve it shortly, and you'll be able to battle once they do.`,
      colours.good,
      "Placement request sent",
    );
  },
};

// --- /profile --------------------------------------------------------------

export const profile = {
  data: new SlashCommandBuilder().setName("profile").setDescription("See your ladder card: points, band, rank and record."),

  async execute(interaction) {
    const target = interaction.options.getUser?.("player") ?? interaction.user;
    const player = db.getPlayer(target.id);
    if (!player) {
      return ephemeral(interaction, `<@${target.id}> isn't on the ladder yet.`, colours.warn, "No player found");
    }
    const rank = db.rankOf(target.id);
    await interaction.reply({ embeds: [playerCardEmbed({ player, rank })], flags: MessageFlags.Ephemeral });
  },
};

// --- /battle ---------------------------------------------------------------

export const battle = {
  data: new SlashCommandBuilder().setName("battle").setDescription("Open a ticket and get matched with an opponent."),

  async execute(interaction) {
    const player = await requirePlacedPlayer(interaction);
    if (!player) return;

    const active = db.getActiveMatchForPlayer(player.discord_id);
    if (active) {
      const ch = active.channel_id ? `<#${active.channel_id}>` : "your match channel";
      return ephemeral(interaction, `You're already in a match: ${ch}.`, colours.warn, "Already fighting");
    }

    const existingTicket = db.getOpenTicket(player.discord_id);
    if (existingTicket) {
      return ephemeral(interaction, "You already have a ticket open. Use `/cancel` to withdraw it.", colours.warn, "Already queued");
    }

    const band = bandForScore(player.points);

    // Higher-band players get a private ticket thread straight away; everyone
    // queues in the database either way.
    let threadId = null;
    try {
      const ticketChannel = await interaction.client.channels.fetch(config.channels.tickets);
      if (ticketChannel && ticketChannel.type === ChannelType.GuildText) {
        const thread = await ticketChannel.threads.create({
          name: `ticket-${player.display_name}`.slice(0, 90),
          autoArchiveDuration: 1440,
          reason: `Battle ticket for ${player.display_name}`,
        });
        threadId = thread.id;
        await thread.send({
          content: `<@${player.discord_id}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(colours.neutral)
              .setTitle("Ticket open â looking for a match")
              .setDescription(
                `You're queued in **${band.name}**. I'm looking for someone in your band first${
                  band.order < HIGHEST_ORDER ? ", then one band above or below after a while" : ""
                }.`,
              )
              .addFields(
                { name: "Your points", value: `${player.points}`, inline: true },
                { name: "Your band", value: band.name, inline: true },
                {
                  name: "What happens next",
                  value:
                    band.order > LOWEST_ORDER
                      ? "The band below you can match with you immediately. Someone above you becomes available after the wait."
                      : "Nothing below you â Bronze is the floor. You'll match with your own band, or the band above once the wait passes.",
                },
              )
              .setFooter({ text: "Use /cancel to withdraw." }),
          ],
        });
      }
    } catch {
      threadId = null;
    }

    db.openTicket(player.discord_id, band.order);

    return ephemeral(
      interaction,
      `Ticket open in **${band.name}**${threadId ? ` â your ticket thread is <#${threadId}>` : ""}. You'll be pinged here and moved into a private match channel when an opponent is found.`,
      colours.good,
      "Searching for a match",
    );
  },
};

// --- /cancel ---------------------------------------------------------------

export const cancel = {
  data: new SlashCommandBuilder().setName("cancel").setDescription("Withdraw your open ticket."),

  async execute(interaction) {
    const ticket = db.getOpenTicket(interaction.user.id);
    if (!ticket) {
      return ephemeral(interaction, "You don't have a ticket open.", colours.warn, "Nothing to cancel");
    }
    db.closeTicket(interaction.user.id);
    return ephemeral(interaction, "Ticket withdrawn. Use `/battle` when you want back in the queue.", colours.good, "Cancelled");
  },
};

// --- /queue ----------------------------------------------------------------

export const queue = {
  data: new SlashCommandBuilder().setName("queue").setDescription("Show who is waiting for a match right now."),

  async execute(interaction) {
    const rows = mm.describeQueue();
    if (rows.length === 0) {
      return ephemeral(interaction, "Nobody is waiting right now.", colours.neutral, "Queue empty");
    }
    const lines = rows.map(
      (r) =>
        `**${r.name}** â ${r.band} Â· waiting ${r.waitedMinutes}m${r.fallbackOpen ? " Â· *fallback open*" : ""}`,
    );
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(colours.neutral)
          .setTitle("Waiting for a match")
          .setDescription(lines.join("\n"))
          .setFooter({ text: `${rows.length} ticket(s) open` }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// --- /leaderboard ----------------------------------------------------------

export const leaderboard = {
  data: new SlashCommandBuilder().setName("leaderboard").setDescription("Post the current standings."),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rows = db.leaderboard(config.leaderboard.size);

    // Post publicly in the leaderboard channel, and show the poster a copy.
    const channel = await interaction.client.channels.fetch(config.channels.leaderboard).catch(() => null);
    if (channel) {
      await channel.send({
        embeds: [leaderboardEmbed({ rows, title: "Ladder standings" })],
      });
      return interaction.editReply({
        embeds: [simpleEmbed(`Posted to <#${channel.id}>.`, colours.good, "Leaderboard posted")],
      });
    }
    return interaction.editReply({ embeds: [leaderboardEmbed({ rows, title: "Ladder standings" })] });
  },
};

// --- /history --------------------------------------------------------------

export const history = {
  data: new SlashCommandBuilder().setName("history").setDescription("Your recent matches and score movements."),

  async execute(interaction) {
    const player = db.getPlayer(interaction.user.id);
    if (!player) return ephemeral(interaction, "You're not on the ladder yet.", colours.warn, "No player found");

    const rows = db.scoreHistory(player.discord_id, 15);
    if (rows.length === 0) return ephemeral(interaction, "No recorded score movements yet.", colours.neutral, "No history");

    const lines = rows.map((r) => {
      const when = `<t:${Math.floor(r.at / 1000)}:d>`;
      const reason = r.reason === "placement" ? "placement" : `match #${r.match_id ?? "â"}`;
      const sign = r.delta >= 0 ? `+${r.delta}` : `${r.delta}`;
      return `${when} Â· ${reason} Â· ${sign} â **${r.after}**`;
    });

    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(colours.neutral).setTitle("Your score history").setDescription(lines.join("\n"))],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// --- staff: /approve, /deny ------------------------------------------------

export const approve = {
  data: new SlashCommandBuilder()
    .setName("approve")
    .setDescription("(Staff) Approve a player's placement.")
    .addUserOption((o) => o.setName("player").setDescription("The player to approve").setRequired(true))
    .addIntegerOption((o) => o.setName("score").setDescription("Override the starting score").setRequired(false).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    if (!isStaff(interaction)) return ephemeral(interaction, "Staff only.", colours.bad, "Not allowed");
    const target = interaction.options.getUser("player");
    const override = interaction.options.getInteger("score");

    const player = db.getPlayer(target.id);
    if (!player) return ephemeral(interaction, "That user isn't registered.", colours.bad, "No registration");

    const approved = db.approvePlayer(target.id, interaction.user.id, override ?? undefined);
    const band = bandForScore(approved.points);

    await svc.audit(
      interaction.guild,
      `<@${interaction.user.id}> approved <@${target.id}> at **${approved.points}** points (${band.name})${override ? " â score overridden" : ""}.`,
    );

    // Try to tell the player.
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    await member
      ?.send(
        `You're placed on the Battles ladder at **${approved.points}** points â **${band.name}**. Use \`/battle\` to open a ticket.`,
      )
      .catch(() => {});

    return ephemeral(
      interaction,
      `<@${target.id}> is placed at **${approved.points}** points (${band.name}).`,
      colours.good,
      "Approved",
    );
  },
};

export const deny = {
  data: new SlashCommandBuilder()
    .setName("deny")
    .setDescription("(Staff) Reject a placement request.")
    .addUserOption((o) => o.setName("player").setDescription("The player to reject").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    if (!isStaff(interaction)) return ephemeral(interaction, "Staff only.", colours.bad, "Not allowed");
    const target = interaction.options.getUser("player");
    const player = db.getPlayer(target.id);
    if (!player) return ephemeral(interaction, "That user isn't registered.", colours.bad, "No registration");

    db.denyPlayer(target.id, interaction.user.id);
    await svc.audit(interaction.guild, `<@${interaction.user.id}> denied <@${target.id}>'s placement request.`);
    return ephemeral(interaction, `<@${target.id}>'s request is denied.`, colours.warn, "Denied");
  },
};

// --- staff: /resolve -------------------------------------------------------

export const resolve = {
  data: new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("(Staff) Set the official winner of a disputed match.")
    .addIntegerOption((o) => o.setName("match_id").setDescription("The match ID").setRequired(true))
    .addUserOption((o) => o.setName("winner").setDescription("Who actually won").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    if (!isStaff(interaction)) return ephemeral(interaction, "Staff only.", colours.bad, "Not allowed");

    const matchId = interaction.options.getInteger("match_id");
    const winnerUser = interaction.options.getUser("winner");
    const match = db.getMatch(matchId);

    if (!match) return ephemeral(interaction, `No match with ID ${matchId}.`, colours.bad, "Match not found");
    if (match.status !== "active") {
      return ephemeral(interaction, `Match #${matchId} is already \`${match.status}\`.`, colours.warn, "Nothing to resolve");
    }
    if (![match.player_a, match.player_b].includes(winnerUser.id)) {
      return ephemeral(interaction, "That user wasn't in this match.", colours.bad, "Wrong player");
    }

    await interaction.deferReply();
    const applied = await finishMatch(interaction.client, match, winnerUser.id, `mod:${interaction.user.id}`);
    await svc.audit(
      interaction.guild,
      `<@${interaction.user.id}> resolved match #${matchId}: <@${winnerUser.id}> wins (mod override).`,
    );
    return interaction.editReply({
      embeds: [
        simpleEmbed(
          `<@${winnerUser.id}> wins match #${matchId}. Applied ${applied.winnerDelta >= 0 ? "+" : ""}${applied.winnerDelta} / ${applied.loserDelta}.`,
          colours.good,
          "Result set",
        ),
      ],
    });
  },
};

// --- staff: /setpoints, /playerlist ----------------------------------------

export const setpoints = {
  data: new SlashCommandBuilder()
    .setName("setpoints")
    .setDescription("(Staff) Correct a player's points.")
    .addUserOption((o) => o.setName("player").setDescription("The player").setRequired(true))
    .addIntegerOption((o) => o.setName("points").setDescription("Their new points total").setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    if (!isStaff(interaction)) return ephemeral(interaction, "Staff only.", colours.bad, "Not allowed");
    const target = interaction.options.getUser("player");
    const newPoints = interaction.options.getInteger("points");
    const player = db.getPlayer(target.id);
    if (!player) return ephemeral(interaction, "That user isn't registered.", colours.bad, "No registration");

    const { before } = db.setPlayerPoints(target.id, newPoints, interaction.user.id);

    await svc.audit(
      interaction.guild,
      `<@${interaction.user.id}> changed <@${target.id}> from ${before} to **${newPoints}** points.`,
    );
    return ephemeral(
      interaction,
      `<@${target.id}>: ${before} â **${newPoints}** (${bandForScore(newPoints).name}).`,
      colours.good,
      "Points updated",
    );
  },
};

export const playerlist = {
  data: new SlashCommandBuilder()
    .setName("playerlist")
    .setDescription("(Staff) List every placed player with their status.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    if (!isStaff(interaction)) return ephemeral(interaction, "Staff only.", colours.bad, "Not allowed");
    const rows = db.allPlayersWithStatus();
    if (rows.length === 0) return ephemeral(interaction, "No players registered.", colours.neutral, "Empty");

    const lines = rows.map(
      (r) => `<@${r.discord_id}> Â· \`${r.governor_id}\` Â· ${r.points} pts Â· \`${r.status}\``,
    );
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(colours.neutral)
          .setTitle(`Players (${rows.length})`)
          .setDescription(lines.join("\n").slice(0, 4000)),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// --- shared: finishing a match ---------------------------------------------

/**
 * Apply a decided match: compute points, write the ledger, announce, close the
 * channel. Used by both the player-agreement path and /resolve.
 */
export async function finishMatch(client, match, winnerId, reason) {
  const loserId = match.player_a === winnerId ? match.player_b : match.player_a;
  const winner = db.getPlayer(winnerId);
  const loser = db.getPlayer(loserId);

  if (!winner || !loser) throw new Error("A player in this match is missing from the database.");

  const winnerOrder = bandForScore(winner.points).order;
  const loserOrder = bandForScore(loser.points).order;

  const { winnerDelta, loserDelta } = pointsForResult({
    winnerOrder,
    loserOrder,
    points: config.points,
  });

  const applied = db.applyMatchResult({
    matchId: match.id,
    winnerId,
    loserId,
    winnerDelta,
    loserDelta,
    reason,
  });

  const fresh = db.getMatch(match.id);
  const guild = client.guilds.cache.get(config.guildId) ?? client.guilds.cache.first();

  if (guild) {
    await svc.announceResult(guild, fresh, {
      winnerDelta,
      loserDelta,
      winnerAfter: applied.winnerAfter,
      loserAfter: applied.loserAfter,
    });
    await svc.closeMatchChannel(guild, fresh);
  }

  return { ...applied, winnerDelta, loserDelta };
}

// --- button handlers -------------------------------------------------------

export async function handleRegistrationButton(interaction) {
  const [, action, targetId] = interaction.customId.split(":");
  if (!isStaff(interaction)) {
    return interaction.reply({ embeds: [simpleEmbed("Staff only.", colours.bad)], flags: MessageFlags.Ephemeral });
  }
  const player = db.getPlayer(targetId);
  if (!player) {
    return interaction.reply({ embeds: [simpleEmbed("That registration is gone.", colours.bad)], flags: MessageFlags.Ephemeral });
  }
  if (player.status !== "pending") {
    return interaction.reply({
      embeds: [simpleEmbed(`Already handled â this registration is \`${player.status}\`.`, colours.warn)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === "approve") {
    const approved = db.approvePlayer(targetId, interaction.user.id);
    const band = bandForScore(approved.points);
    await svc.audit(
      interaction.guild,
      `<@${interaction.user.id}> approved <@${targetId}> at **${approved.points}** (${band.name}).`,
    );
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    await member
      ?.send(`You're placed at **${approved.points}** points â **${band.name}**. Use \`/battle\` when you're ready.`)
      .catch(() => {});
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(colours.good)
          .setTitle("Approved")
          .setDescription(`<@${targetId}> placed at **${approved.points}** points (${band.name}). Approved by <@${interaction.user.id}>.`),
      ],
      components: [],
    });
  }

  db.denyPlayer(targetId, interaction.user.id);
  await svc.audit(interaction.guild, `<@${interaction.user.id}> denied <@${targetId}>.`);
  return interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(colours.bad)
        .setTitle("Denied")
        .setDescription(`<@${targetId}>'s placement request was declined by <@${interaction.user.id}>.`),
    ],
    components: [],
  });
}

export async function handleClaimButton(interaction) {
  const [, kind, idRaw] = interaction.customId.split(":");
  const matchId = Number.parseInt(idRaw, 10);
  const match = db.getMatch(matchId);

  if (!match || match.status !== "active") {
    return interaction.reply({
      embeds: [simpleEmbed("That match is already closed.", colours.warn)],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (![match.player_a, match.player_b].includes(interaction.user.id)) {
    return interaction.reply({ embeds: [simpleEmbed("You're not in this match.", colours.bad)], flags: MessageFlags.Ephemeral });
  }

  if (kind === "dispute") {
    await interaction.reply({
      embeds: [disputeEmbed({ match, claimant: interaction.user.id, claimed: "the result is disputed" })],
    });
    const staffChannel = await interaction.client.channels
      .fetch(config.channels.staffApprovals)
      .catch(() => null);
    await staffChannel
      ?.send({
        content: `<@&${config.roles.staff}>`,
        embeds: [
          disputeEmbed({ match, claimant: interaction.user.id, claimed: "the result is disputed" }).setTitle(
            `Match #${matchId} needs a moderator`,
          ),
        ],
      })
      .catch(() => {});
    return;
  }

  // kind === "win": record the claim.
  const duel = db.setClaim(matchId, interaction.user.id, interaction.user.id);

  // Both claimed? Compare.
  if (duel.claim_a && duel.claim_b) {
    if (duel.claim_a === duel.claim_b) {
      await interaction.reply({ embeds: [simpleEmbed("Both agree â applying the result.", colours.good, "Confirmed")] });
      await finishMatch(interaction.client, duel, duel.claim_a, "players-agreed");
      return;
    }
    // Disagreement: escalate.
    await interaction.reply({
      embeds: [disputeEmbed({ match: duel, claimant: interaction.user.id, claimed: "they won" })],
    });
    const staffChannel = await interaction.client.channels
      .fetch(config.channels.staffApprovals)
      .catch(() => null);
    await staffChannel
      ?.send({
        content: `<@&${config.roles.staff}>`,
        embeds: [
          disputeEmbed({ match: duel, claimant: interaction.user.id, claimed: "they won" }).setTitle(
            `Match #${matchId} â players disagree`,
          ),
        ],
      })
      .catch(() => {});
    return;
  }

  const opponentId = match.player_a === interaction.user.id ? match.player_b : match.player_a;

  await interaction.reply({
    embeds: [
      simpleEmbed(
        `Recorded: you say **${interaction.user.displayName ?? interaction.user.username}** won. Waiting on <@${opponentId}> to answer.`,
        colours.neutral,
        "Claim noted",
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
  await interaction.channel
    .send({ embeds: [simpleEmbed(`<@${interaction.user.id}> has answered. <@${opponentId}> â your vote?`, colours.neutral)] })
    .catch(() => {});
}

export const commands = [
  register,
  profile,
  battle,
  cancel,
  queue,
  leaderboard,
  history,
  approve,
  deny,
  resolve,
  setpoints,
  playerlist,
];
