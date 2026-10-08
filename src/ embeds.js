// ---------------------------------------------------------------------------
// embeds.js - all user-facing presentation in one place, so the wording stays
// consistent and can be edited without touching logic.
// ---------------------------------------------------------------------------

import { EmbedBuilder } from "discord.js";
import { bandForScore } from "./bands.js";

const COLOUR = {
  neutral: 0x5865f2,
  good: 0x57f287,
  bad: 0xed4245,
  warn: 0xfee75c,
  brand: 0x1f3864,
};

export const colours = COLOUR;

export function registrationEmbed({ player, user }) {
  return new EmbedBuilder()
    .setColor(COLOUR.brand)
    .setTitle("New placement request")
    .setDescription(`${user} wants to join the ladder.`)
    .addFields(
      { name: "Discord", value: `<@${player.discord_id}>`, inline: true },
      { name: "Governor ID", value: `\`${player.governor_id}\``, inline: true },
      { name: "Claimed Mystic Trials score", value: `${player.start_score}`, inline: true },
      { name: "Band they'd start in", value: bandForScore(player.start_score).name, inline: true },
    )
    .setFooter({ text: "Check the score, then Approve or Deny. Nothing is active until you do." })
    .setTimestamp();
}

export function playerCardEmbed({ player, rank }) {
  const band = bandForScore(player.points);
  const total = player.wins + player.losses;
  const rate = total === 0 ? "—" : `${Math.round((player.wins / total) * 100)}%`;

  return new EmbedBuilder()
    .setColor(COLOUR.brand)
    .setTitle(player.display_name)
    .addFields(
      { name: "Points", value: `${player.points}`, inline: true },
      { name: "Band", value: band.name, inline: true },
      { name: "Rank", value: rank ? `#${rank}` : "—", inline: true },
      { name: "Record", value: `${player.wins}W / ${player.losses}L`, inline: true },
      { name: "Win rate", value: rate, inline: true },
      { name: "Governor ID", value: `\`${player.governor_id}\``, inline: true },
    )
    .setFooter({ text: `Started at ${player.start_score} from Mystic Trials` });
}

export function ticketEmbed({ player, band }) {
  return new EmbedBuilder()
    .setColor(COLOUR.neutral)
    .setTitle("Ticket open — looking for a match")
    .setDescription(
      `You are queued in **${band.name}**. The system is looking for someone in your band first.`,
    )
    .addFields(
      { name: "Your points", value: `${player.points}`, inline: true },
      { name: "Your band", value: band.name, inline: true },
    )
    .setFooter({ text: "If nobody in your band turns up, it looks one band up or down after a while." })
    .setTimestamp();
}

export function matchFoundEmbed({ match, players, bands, channelId }) {
  const [a, b] = players;
  const gap = Math.abs(bands[0].order - bands[1].order);
  const stakes =
    gap === 0
      ? "This is a **same-band** match: the winner takes **+50**, the loser drops **50**."
      : "This is a **cross-band** match. The higher-band player wins **25** or loses **75**; the lower-band player wins **75** or loses **25**.";

  return new EmbedBuilder()
    .setColor(COLOUR.good)
    .setTitle(`Match #${match.id} — you're up`)
    .setDescription(
      `<@${a.discord_id}> (${bands[0].name}, ${a.points}) vs <@${b.discord_id}> (${bands[1].name}, ${b.points})`,
    )
    .addFields(
      { name: "Stakes", value: stakes },
      {
        name: "What to do",
        value: [
          "1. Fight three rounds in game.",
          "2. Come back here and **both** press the button for who won.",
          "3. If you disagree, post a screenshot each and staff will decide.",
        ].join("\n"),
      },
    )
    .setFooter({ text: `Match ID ${match.id} · channel ${channelId}` })
    .setTimestamp();
}

export function resultConfirmedEmbed({ match, winner, loser, winnerDelta, loserDelta, winnerAfter, loserAfter, bands }) {
  return new EmbedBuilder()
    .setColor(COLOUR.good)
    .setTitle(`Match #${match.id} — result confirmed`)
    .setDescription(`<@${winner.discord_id}> wins.`)
    .addFields(
      {
        name: `${winner.display_name} (winner)`,
        value: `${winnerAfter - winnerDelta} → **${winnerAfter}** (${signed(winnerDelta)}) · ${bands.winner}`,
        inline: false,
      },
      {
        name: `${loser.display_name} (loser)`,
        value: `${loserAfter + Math.abs(loserDelta)} → **${loserAfter}** (${signed(loserDelta)}) · ${bands.loser}`,
        inline: false,
      },
    )
    .setFooter({ text: "Recorded and logged." })
    .setTimestamp();
}

export function disputeEmbed({ match, claimant, claimed }) {
  return new EmbedBuilder()
    .setColor(COLOUR.warn)
    .setTitle(`Match #${match.id} — dispute`)
    .setDescription(
      `<@${claimant}> says **${claimed}** won. The two accounts don't match, so a moderator needs to decide.`,
    )
    .addFields({
      name: "What staff need",
      value: "A screenshot from **both** players. With only one side's evidence there is nothing to weigh it against.",
    })
    .setFooter({ text: "Staff: use /resolve with the match ID once you've seen both screenshots." })
    .setTimestamp();
}

export function leaderboardEmbed({ rows, title = "Ladder standings" }) {
  if (rows.length === 0) {
    return new EmbedBuilder()
      .setColor(COLOUR.brand)
      .setTitle(title)
      .setDescription("No placed players yet.");
  }

  const medal = (p) => (p === 1 ? "🥇" : p === 2 ? "🥈" : p === 3 ? "🥉" : `#${p}`);

  const lines = rows.map((r) => {
    const total = r.wins + r.losses;
    const rate = total === 0 ? "—" : `${Math.round((r.wins / total) * 100)}%`;
    return `**${medal(r.position)}**  ${r.display_name} — **${r.points}** · ${r.band.name} · ${r.wins}W/${r.losses}L (${rate})`;
  });

  return new EmbedBuilder()
    .setColor(COLOUR.brand)
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Snapshot only — points never reset." })
    .setTimestamp();
}

export function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function simpleEmbed(description, colour = COLOUR.neutral, title = null) {
  const e = new EmbedBuilder().setColor(colour).setDescription(description);
  if (title) e.setTitle(title);
  return e;
}
