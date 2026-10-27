# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-27

### Added
- `/status`, `/start` and `/stop` commands. `/restart` now reports
  "starting" when the server was stopped, not "restarting".
- Startup warning when `ADMIN_ROLE_ID` is a role name, which anyone who can
  create roles can spoof. Use the numeric role ID.

### Fixed
- `/connect` gave out a stale join code: the join-code regex now matches
  Valheim 1.0.20's `registered with join code` log line (the old
  `Created new join code` format is still matched).
- Ghost players after a bot restart: the startup replay now times the
  leave-lobby dedupe by log timestamp instead of wall-clock time.
- Player names can no longer trigger mentions (e.g. a character named
  `@everyone`) and are markdown-escaped. Mentions are only enabled for the
  bot's own `UPDATE_MENTION_ROLE_ID` prefix.
- `/stop` and `/restart` give the server 60s to shut down (was Docker's
  default 10s), so Valheim isn't killed mid world-save.
- Player tracking recovers on its own if the log `tail` process dies,
  instead of staying off until the bot restarts.
- Doubled join announcements on respawn (the placeholder zdoid `0` is now
  ignored).
- Duplicate roster entries when a player reconnects under a new zdoid.
- The startup replay window now uses wall-clock time with timezone-aware
  log timestamps, so stale logs no longer re-announce old events.
- `Unknown interaction` errors: every command now acks immediately.
- The "container doesn't exist" reply names the container and points at a
  possible second bot instance as the cause.

### Changed
- Docker image runs on Node 22 (Node 20 is end-of-life) and installs with
  `npm ci`.
- Dependencies updated within their existing version ranges.
- `.claude/` is gitignored.

## [1.0.0] - 2026-09-13

Initial release: Discord bot for a Dockerized crossplay Valheim server.
Player join/leave tracking from the server log, version and join-code
announcements, `/players`, `/version`, `/connect`, `/schedule`, `/help`,
and an admin-only `/restart`.

[1.1.0]: https://github.com/giroguy/valheim-discord-bot/compare/v1.0...v1.1.0
[1.0.0]: https://github.com/giroguy/valheim-discord-bot/releases/tag/v1.0
