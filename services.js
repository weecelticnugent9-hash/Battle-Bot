// ---------------------------------------------------------------------------
// services.js - the Discord-touching glue: creating match channels, moving
// players in, closing them out. Kept separate from matchmaker.js so the
// pairing logic stays testable without a running client.
// ---------------------------------------------------------------------------

import { ChannelType, PermissionFlagsBits } from "discord.js";
import config from "./config.js";
import * as db from "./db.js";
import { bandForScore } from "./bands.js";
import { matchFoundEmbed, resultConfirmedEmbed, simpleEmbed, colours } from "./embeds.js";

/**
 * Ensure the match-participant role exists, creating it if needed. The role ID
 * is persisted so restarts don't create duplicates.
 */
export async function ensureParticipantRole(guild) {
  const saved = db.getSetting("match_participant_role");
  if (saved) {
    const existing =
      guild.roles.cache.get(saved) ?? (await guild.roles.fetch(saved).catch(() => null));
    if (existing) return existing;
  }
  if (config.roles.matchParticipant) {
    const configured = guild.roles.cache.get(config.roles.matchParticipant);
    if (configured) {
      db.setSetting("match_participant_role", configured.id);
      return configured;
    }
  }
  const created = await guild.roles.create({
    name: "Match Participant",
    color: 0x5865f2,
    mentionable: false,
    reason: "Battles bot: role applied to players during an active match.",
  });
  db.setSetting("match_participant_role", created.id);
  return created;
}

/**
 * Create the private match channel for a reserved match and post the opener.
 * Returns the created channel.
 */
export async function createMatchChannel(guild, match) {
  const playerA = db.getPlayer(match.player_a);
  const playerB = db.getPlayer(match.player_b);
  const bandA = bandForScore(playerA.points);
  const bandB = bandForScore(playerB.points);
  const role = await ensureParticipantRole(guild);

  const channel = await guild.channels.create({
    name: `match-${match.id}`,
    type: ChannelType.GuildText,
    parent: config.categories.matches || undefined,
    topic: `Match #${match.id} — ${playerA.display_name} vs ${playerB.display_name}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: config.roles.staff,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ],
  });

  // Grant the two fighters access individually, so a role-application failure
  // can never lock them out of their own match.
  for (const p of [playerA, playerB]) {
    await channel.permissionOverwrites
      .edit(p.discord_id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      })
      .catch(() => {});
    const member = await guild.members.fetch(p.discord_id).catch(() => null);
    if (member && !member.roles.cache.has(role.id)) {
      await member.roles.add(role, `Match #${match.id} started`).catch(() => {});
    }
  }

  await channel.send({
    content: `<@${playerA.discord_id}> <@${playerB.discord_id}>`,
    embeds: [
      matchFoundEmbed({
        match,
        players: [playerA, playerB],
        bands: [bandA, bandB],
        channelId: channel.id,
      }),
    ],
  });

  await channel.send(claimComponents(match.id));

  return channel;
}

/**
 * The two claim buttons. Buttons carry the match id so they stay correct if
 * the bot restarts mid-match.
 */
export function claimComponents(matchId) {
  return {
    content: "**Who won? Both of you need to answer.**",
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "I won", custom_id: `claim:win:${matchId}` },
          { type: 2, style: 4, label: "I need a mod", custom_id: `claim:dispute:${matchId}` },
        ],
      },
    ],
  };
}

/**
 * Close a finished match: drop the participant role from both fighters and
 * lock the channel against further posting.
 */
export async function closeMatchChannel(guild, match, { keep = false } = {}) {
  const role = db.getSetting("match_participant_role");
  for (const id of [match.player_a, match.player_b]) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member && role && member.roles.cache.has(role)) {
      await member.roles.remove(role, `Match #${match.id} finished`).catch(() => {});
    }
  }

  if (keep) return;

  const channel =
    guild.channels.cache.get(match.channel_id) ??
    (await guild.channels.fetch(match.channel_id).catch(() => null));
  if (!channel) return;

  await channel
    .send({
      embeds: [simpleEmbed("Match finished. This channel locks in 30 seconds.", colours.neutral)],
    })
    .catch(() => {});

  setTimeout(() => {
    channel.permissionOverwrites
      .edit(guild.roles.everyone.id, { SendMessages: false })
      .catch(() => {});
  }, 30000);
}

/**
 * Post the applied-result summary to the match channel before it closes.
 *
 * `applied` carries the before/after pair for each side, so the embed can show
 * the old score as well as the new one without re-reading the database.
 */
export async function announceResult(guild, match, applied) {
  const channel =
    guild.channels.cache.get(match.channel_id) ??
    (await guild.channels.fetch(match.channel_id).catch(() => null));
  if (!channel) return;

  const winner = db.getPlayer(match.winner);
  const loserId = match.player_a === match.winner ? match.player_b : match.player_a;
  const loser = db.getPlayer(loserId);

  await channel
    .send({
      embeds: [
        resultConfirmedEmbed({
          match,
          winner,
          loser,
          winnerDelta: applied.winnerDelta,
          loserDelta: applied.loserDelta,
          winnerAfter: applied.winnerAfter,
          loserAfter: applied.loserAfter,
          bands: {
            winner: bandForScore(applied.winnerAfter).name,
            loser: bandForScore(applied.loserAfter).name,
          },
        }),
      ],
    })
    .catch(() => {});
}

/** Write an audit line to the staff channel. Never throws. */
export async function audit(guild, text) {
  try {
    const channel =
      guild.channels.cache.get(config.channels.staffApprovals) ??
      (await guild.channels.fetch(config.channels.staffApprovals).catch(() => null));
    if (channel) await channel.send({ embeds: [simpleEmbed(text, colours.neutral, "Audit")] });
  } catch {
    // Audit logging must never break a user-facing action.
  }
}
