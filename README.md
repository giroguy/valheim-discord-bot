# Valheim Discord Bot

Discord bot for a Valheim dedicated server: who's online, version/update
tracking, the current cross-platform join code, and a remote restart command.

Standalone Docker Compose project - separate from the Valheim game server's
own compose project (`../your-valheim-server` by default), on purpose. The two are fully
independent: no shared Docker network, no bring-up-order dependency. This
bot reaches the game server only via two read-only file mounts (the log
file, and the game server's own env file) plus the Docker socket for
`/restart` - see [Setup](#setup).

## Commands

| Command | What it does | Access |
|---|---|---|
| `/help` | Lists all commands | anyone |
| `/players` | Who's currently online (from log-based tracking) | anyone |
| `/version` | Last observed Valheim version | anyone |
| `/connect` | Current join code (works for Steam/Xbox/PlayStation) | anyone |
| `/schedule` | Next auto-update/auto-backup/scheduled-restart times, human-readable | anyone |
| `/restart` | Restarts the game server container via the Docker socket | `ADMIN_ROLE_ID` only |

Join/leave, version-change, and join-code-change events also post
proactively to `DISCORD_WEBHOOK_URL` as they happen - no command needed.

## Why it doesn't use Huginn/Odin's own status endpoints

The image bundles a status server (Huginn) with `/status`, `/players`, and
`/metadata` endpoints. Two problems ruled all of them out:

- `/status` and `/players` are populated by an actual Steam server query,
  which is broken whenever `ENABLE_CROSSPLAY=1` (confirmed: a known,
  acknowledged limitation in Valheim itself, not fixable in the image or
  here) - reports `version: "Unknown"`, `players: 0`, `online: false`
  regardless of the server's real state.
- `/metadata` (which `/schedule` originally used, since it reads local
  env-var config rather than a live query, so it's unaffected by the
  crossplay issue) simply **doesn't exist** in the Huginn build actually
  bundled in the deployed `mbround18/valheim:latest` image - confirmed via
  a direct `curl`, 404 with an empty body. That route only exists in the
  project's current GitHub source, which is ahead of what's published.

So this bot avoids Huginn entirely: `valheim_server.log` is tailed
directly for player/version/join-code tracking, and `/schedule` reads
the game server's own env file directly too (`src/envFile.js`) - the exact same
source of truth Huginn's `/metadata` would have read from, just without
depending on that specific route existing in whatever image version is
actually deployed.

## How player tracking works (and its limits)

`src/logWatcher.js` parses joins/leaves in real time from the log. There
are three distinct disconnect patterns Valheim produces (graceful leave,
version-mismatch kick, abrupt/dropped connection), and only one line -
`ZPlayFabSocket::Dispose. leave lobby` - reliably appears in all three, so
that's the fallback leave signal. Where possible (abrupt disconnects), the
`Destroying abandoned non persistent zdo ... owner <id>` line gives a
precise player-to-zdoid attribution instead of a guess.

`Got character ZDOID from X` (the join signal) isn't unique to a fresh
connection either - it also fires on respawn after death, reusing the same
zdoid each time. It's only treated as an actual join (roster addition +
announcement) the first time that zdoid is seen; a repeat is recognized as
a respawn and updates state silently without re-announcing.

When a leave is ambiguous (2+ players tracked, no precise attribution),
the *oldest*-tracked player is guessed and removed so the roster count
stays right immediately; the announcement itself stays generic ("A player
disconnected") since the guess may be wrong. A later `now N player(s)`
line from the server, when present, corrects the roster size if it's
drifted. This is inherent to log-scraping without a working query
protocol - good enough for a small friend/community server, not perfect
under simultaneous joins/leaves.

`tail -n 0 -F` only ever sees lines appended *after* the tail process
starts - on its own, that means every bot restart would silently reset the
roster to empty even if the game server (and its players) never went
anywhere. To fix that, `LogWatcher.start()` first replays whatever's
currently in the log file (silently - no Discord spam for history the
server already told everyone about days ago), reconstructing the real
current roster, before switching to live tailing. That replay is bounded
to a recent window (`REPLAY_WINDOW_MS`, 6h by default) rather than the
whole file: a long uninterrupted session could accumulate a large log, and
replaying further back increases the chance a single missed-parse edge
case (see the ambiguous-leave heuristic above) leaves a permanent "ghost"
entry rather than a self-correcting recent one. The window is computed
relative to the log's own last timestamp, not the bot container's system
clock, so it's unaffected by any timezone mismatch between the two
containers.

Version and join code are also replayed (not silenced - unlike join/leave,
their own handlers in `index.js` already gate on *change*, so replaying
them is what lets a freshly restarted bot learn the current values from an
already-running server instead of waiting for its next real restart), and
persisted to `./data` on top of that so even values outside the replay
window survive a bot restart.

## Setup

1. **Create a Discord bot application** (Developer Portal):
   - New Application - Bot - Reset Token (save it, you'll need it below).
   - OAuth2 - URL Generator - scopes: `bot` **and** `applications.commands`
     (missing `applications.commands` causes slash command registration to
     fail with `Missing Access`). No bot permissions are required - all
     messaging happens through the webhook below, not the bot connection.
   - Open the generated URL, invite it to your server.

2. **Configure secrets**: copy `valheim-bot.env.example` to
   `valheim-bot.env` and fill in `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`,
   `DISCORD_WEBHOOK_URL`, `ADMIN_ROLE_ID`, and optionally
   `DISCORD_GUILD_ID` / `UPDATE_MENTION_ROLE_ID`. Comments in that file
   explain where to find each value. `ADMIN_ROLE_ID` and
   `UPDATE_MENTION_ROLE_ID` accept either a role **name** or its numeric ID
   (plus `@here`/`@everyone` for the mention one) - no need to enable
   Developer Mode just to copy a snowflake ID.

3. **Configure paths**: copy `.env.example` to `.env` (compose-level
   interpolation, different from `valheim-bot.env`) and set
   `VALHEIM_LOG_HOST_PATH` and `VALHEIM_ENV_HOST_PATH` to the correct host
   paths to your game server's log directory and its own env file. Defaults
   assume the two projects are laid out as sibling directories; use
   absolute paths if not. Also set `BOT_CONTAINER_NAME` there if you want
   something other than the default `valheim-bot`, and
   `VALHEIM_CONTAINER_NAME` in `valheim-bot.env` to match your game
   server's actual container name.

4. Bring up either project in any order - they're fully independent:

   ```
   docker compose up -d --build
   ```

## Local development

The real (amd64) game server can't run reliably on Apple Silicon - SteamCMD
ships a 32-bit x86 binary that segfaults under Rosetta/QEMU emulation. For
local bot development:

```
docker compose up -d --build --no-deps   # bot only
```

Then feed synthetic lines into the mounted log file to exercise the parser
without a real server, e.g.:

```
echo '09/12/2026 16:00:00: Got character ZDOID from TestPlayer : 42424242:1' >> <log path>
```

This posts real messages to whatever `DISCORD_WEBHOOK_URL` is configured -
point it at a test channel if you don't want that hitting the live one.

## Crash resilience

Every interaction handler runs inside a try/catch (`handleCommand` in
`src/index.js`), and the Discord client has an `error` listener - without
both, an unhandled Discord API error (e.g. a transient `Unknown
interaction` on a reply) becomes an unhandled `'error'` event, which
Node's default behavior is to throw and crash the entire process, not
just fail that one command. Confirmed this actually happened in
production: `/players` hit `DiscordAPIError[10062]` mid-reply and took
the whole bot down until `restart: always` brought it back ~2 seconds
later - during which player tracking and webhook posting were also down,
not just that one command.

## Restart mechanism and its trust boundary

`/restart` mounts `/var/run/docker.sock` into the bot container and calls
the Docker API directly (`src/dockerControl.js`) - this works regardless of
which compose project owns the target container, since it talks to the
daemon by container name (`VALHEIM_CONTAINER_NAME`), not through Compose.

Worth knowing: any process with Docker socket access has root-equivalent
control over the whole host, not just this one container. `/restart`
itself is gated to `ADMIN_ROLE_ID`, but that mount is the actual trust
boundary.

## Multiple servers

Not supported by a single bot instance today - see project discussion for
the two paths (redeploy this project again per server vs. a multi-server
refactor with a `server` parameter on every command) if that becomes
needed.
