
# Battles Bot

A Discord ladder bot for Kingshot-style 1v1 battles: players register a
starting score, open tickets, get matched by rank band, fight three rounds in
game, and confirm the result. The bot handles the points, the ranks, and the
monthly leaderboard.

---

## What it does

| Command | Who | What |
|---|---|---|
| `/register` | anyone | Submit your governor ID and Mystic Trials score for approval |
| `/profile` | anyone | Your points, band, rank and record |
| `/battle` | placed players | Open a ticket and get matched |
| `/cancel` | placed players | Withdraw your ticket |
| `/queue` | anyone | See who's waiting |
| `/history` | anyone | Your recent score movements |
| `/leaderboard` | anyone | Post the current standings |
| `/approve`, `/deny` | staff | Handle placement requests |
| `/resolve` | staff | Set the winner of a disputed match |
| `/setpoints` | staff | Correct a player's points |
| `/playerlist` | staff | Every player and their status |

---

## The ladder rules (configurable in the environment)

**Bands** — points decide the band. Move between them the moment you cross a
threshold, up or down.

| Band | Points |
|---|---|
| Diamond | 2700 + |
| Gold | 2300 - 2699 |
| Silver | 2000 - 2299 |
| Bronze II | 1700 - 1999 |
| Bronze | 1 - 1699 |

**Matchmaking** — same band first. After a 30 minute wait, one band above
becomes available. One band **below** is always available with no wait, so a
higher-band player is matchable by the band beneath them the moment they queue.
Never two bands.

**Points**

| | Higher-band player | Lower-band player |
|---|---|---|
| Same band | +50 win / -50 loss | +50 win / -50 loss |
| Cross band - wins | +25 | +75 |
| Cross band - loses | -75 | -25 |

The floor is 1. Nobody goes negative.

**Results** — both players press "I won". If they agree, it's applied. If they
disagree, staff decide from both players' screenshots via `/resolve`.

**Leaderboard** — posted automatically on the 1st of each month. Snapshot
only; points never reset.

---

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**.
2. Go to **Bot** in the sidebar.
3. Under **Privileged Gateway Intents**, enable **Server Members Intent**.
   Leave Presence and Message Content **off**.
4. Click **Reset Token** and copy it. This is your `DISCORD_TOKEN`.
   **Never commit it, never paste it in a chat.**
5. Go to **General Information** and copy the **Application ID**. This is your
   `CLIENT_ID`.

### 2. Invite the bot to your server

1. Go to **OAuth2 -> URL Generator**.
2. Scopes: tick `bot` and `applications.commands`.
3. Bot Permissions: tick
   - Manage Channels
   - Manage Roles *(the bot's role must sit **above** the role it assigns - see below)*
   - Manage Messages
   - Send Messages
   - Embed Links
   - Read Message History
   - Create Private Threads
   - Send Messages in Threads
4. Leave **Administrator** unticked.
5. Copy the generated URL, open it, and pick your server.
6. You need **Manage Server** permission on that server to do this.

> **Important - role order:** once the bot is in the server, go to
> **Server Settings -> Roles** and drag the bot's role **above** the
> participant role it creates. If the bot's role sits below, it cannot assign
> the role and matches will fail to create properly.

### 3. Create the channels, categories and roles

Make these in your server and note their IDs (enable **Developer Mode** in
Discord's Advanced settings, then right-click to **Copy ID**):

| Thing | Put the ID in |
|---|---|
| Staff/approvals channel | `CHANNEL_STAFF_APPROVALS` |
| Leaderboard channel | `CHANNEL_LEADERBOARD` |
| Tickets channel | `CHANNEL_TICKETS` |
| Category for match channels | `CATEGORY_MATCHES` |
| Category for the public battles channels | `CATEGORY_TICKETS` |
| Staff/moderator role | `ROLE_STAFF` |

You do **not** need to create the participant role - the bot makes it on first
boot and remembers the ID.

### 4. Push to GitHub

```bash
git init
git add .
git commit -m "Battles bot"
git branch -M main
git remote add origin https://github.com/YOURNAME/battles-bot.git
git push -u origin main
```

`.gitignore` already excludes `.env` and the database, so the token can't be
committed by accident.

### 5. Deploy on Railway

1. **New Project -> Deploy from GitHub repo** -> pick your repo.
2. Railway will detect Node and run `npm start`. If not, set the start command
   to `npm start` in **Settings**.
3. Open the **Variables** tab and add every variable from `.env.example`,
   with your real values. (Do not create a `.env` file on Railway.)

### 6. **Mount a volume - do not skip this**

Railway wipes a container's filesystem on every deploy. Without a volume, the
SQLite database is deleted on each push, taking every player, score and match
with it.

1. Right-click the service and choose **Attach Volume**.
2. Set the **mount path** to `/data`.
3. Add the variable `DATABASE_PATH=/data/battles.db`.

Now the database survives deploys. **Verify it**: deploy once, register a test
player, push any trivial change, and check the player is still there.

### 7. Publishing the slash commands

Battle commands are published by running the `register-commands` script once
with your environment variables available:

```bash
npm install
npm run register-commands
```

If you are running entirely on Railway, either run this locally once with the
same values, or add a one-off Railway command. Commands only need re-publishing
if you add or rename one.

### 8. Testing the logic

```bash
node test/logic.test.js
```

This checks band lookup, the matchmaking ranges, the points tables, the floor,
and the exact numbers for the first two test players.

---

## Testing with two players

Your first two placements will land in the same band if their scores are close,
which is what you want for a first run.

1. Both run `/register` with their governor ID and score.
2. Staff approve both - check the score against the Mystic Trials recording.
3. Both run `/battle`. Within one matchmaker tick (20s default) a private
   channel appears and both are pinged.
4. Do a fake set of three rounds, then **both** press "I won" for the same
   person. With one person pressing it, wait for the other.
5. The result applies, the channel announces the new points, and `/profile`
   shows the updated band.

Then test the hard paths deliberately:

- **Disagreement** - one presses "I won", the other presses "I need a mod".
  Staff should get a ping, and `/resolve` should apply the result.
- **Boundary** - one player wins enough to cross a band. Their `/profile`
  band should change, and the next `/queue` should show them unable to match
  their old opponent except at cross-band stakes.
- **Floor** - `/setpoints` someone to 30, have them lose, confirm they land on
  1 and not below.

---

## Operational notes

**Changing the rules.** All points values and band thresholds are environment
variables. Change them in Railway, and the bot restarts with the new values -
no code change. Existing points are untouched; only future matches use the new
numbers. If you change a band threshold, everyone's band is recalculated
automatically because bands are derived from points, never stored.

**Audit trail.** Every approval, denial, score change and mod override is
posted to the staff channel, and every point movement is written to a
`score_history` table. Nothing changes silently.

**Backups.** The database is one file on the volume. Download it periodically,
or snapshot the volume. A volume survives deploys, but it is **not a backup** -
if the volume is deleted, the ladder is gone.

**One governor ID per account.** The bot refuses a registration whose governor
ID is already linked to another Discord account. This is what stops someone
running a second account to farm easy matches.

**The matchmaker's asymmetry.** Lower-band players wait 30 minutes before they
can reach up. Higher-band players never wait to be reached down. The effect is
that lower-band players get matched more often and Diamond players wait the
most, since Diamond only has Gold below it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Bot logs in then exits | Bad `DISCORD_TOKEN`, or the bot isn't in the guild in `GUILD_ID` |
| Commands don't appear | `npm run register-commands` not run, or wrong `GUILD_ID`/`CLIENT_ID` |
| Boot log says a channel couldn't be fetched | Wrong channel or category ID, or the bot can't see that channel |
| Registration says staff channel unreachable | `CHANNEL_STAFF_APPROVALS` is wrong or the bot can't see that channel |
| Match channel created but players can't see it | Bot's role is below the participant role in Server Settings -> Roles |
| Ladder empty after a deploy | No volume mounted, or `DATABASE_PATH` doesn't point at it - see step 6 |
| No monthly post | Bot offline at the cron time, or `LEADERBOARD_CRON` invalid (check the logs on boot) |

---

## Project layout

```
src/
  index.js             entry point: client, matchmaking loop, monthly job
  config.js            reads and validates environment variables
  bands.js             band lookup, eligibility, points - pure logic
  db.js                SQLite schema and every query
  matchmaker.js        pairing rules
  services.js          Discord glue: channels, roles, audit
  commands.js          slash commands and button handlers
  embeds.js            all user-facing presentation
  register-commands.js publishes the slash commands
test/
  logic.test.js        logic tests, no framework needed
```
