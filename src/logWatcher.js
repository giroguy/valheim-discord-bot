import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";

// These patterns were reverse-engineered from real valheim_server.log output
// (not documented anywhere by Iron Gate), so treat them as best-effort and
// expect to revisit them if a future game patch changes the log wording -
// this bit us more than once tuning the plain webhook hooks this replaces.

// "Got character ZDOID from SomePlayer : 63283531:1"
const JOIN_RE = /Got character ZDOID from (.+?) : (-?\d+):(-?\d+)/;

// "Destroying abandoned non persistent zdo 830480553:1 owner 830480553"
// Fires on abrupt disconnects (dropped connection, kicked for version
// mismatch, etc). The owner id matches the zdoid captured at join time, so
// this is our most precise way to attribute a leave to a specific player.
const ABANDONED_ZDO_RE =
  /Destroying abandoned non persistent zdo (-?\d+):-?\d+ owner (-?\d+)/;

// "ZPlayFabSocket::Dispose. leave lobby. LobbyId: "
// The one line confirmed present across every disconnect pattern we've
// observed (graceful leave, version-mismatch kick, abrupt drop) - but it
// carries no player-identifying info, so it's the fallback signal only.
const LEAVE_LOBBY_RE = /ZPlayFabSocket::Dispose\. leave lobby/;

// "Player connection lost server "X" that has join code Y, now 2 player(s)"
// "New session server "X" ... is active with 0 player(s)"
// Gives us an authoritative roster size to reconcile against, when present.
const COUNT_RE = /now (\d+) player\(s\)/;

// "Valheim version: l-1.0.7 (network version 39)"
const VERSION_RE = /Valheim version: l-([\d.]+)/;

// "Created new join code 460594 for session "MyServer""
// This is the cross-platform (Steam/Xbox/PlayStation alike) code players
// enter in-game to connect - unlike a steam:// deeplink, it works for
// every platform on a crossplay server. Gets recreated each time the
// server starts a new session, so it changes on every restart.
const JOIN_CODE_RE = /Created new join code (\d+) for session/;

// "09/12/2026 11:57:34: ..." - present on most lines, but not all (some,
// like "ZPlayFabSocket::Dispose. State: CONNECTED", have no timestamp).
const TIMESTAMP_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}):/;

function parseTimestamp(line) {
  const m = line.match(TIMESTAMP_RE);
  if (!m) return null;
  const [, month, day, year, hour, minute, second] = m;
  // Constructed naively (no timezone applied) - fine here, since replay
  // only ever compares this against another timestamp parsed the exact
  // same way from the same log, never against the bot container's own
  // system clock. Any timezone offset cancels out in that comparison.
  return new Date(year, month - 1, day, hour, minute, second);
}

const REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export class LogWatcher extends EventEmitter {
  constructor(logPath) {
    super();
    this.logPath = logPath;
    // zdoid -> player name, for players we currently believe are connected
    this.players = new Map();
    // Timestamp of the last precise (zdoid-attributed) removal, so the
    // generic "leave lobby" signal that follows it in the log doesn't
    // double-remove/double-announce the same disconnect.
    this._recentRemovalAt = 0;
  }

  start() {
    // `tail -n 0` only ever sees lines appended *after* this process starts,
    // so on its own the bot has no way to learn who's already connected at
    // startup (e.g. after a bot-only restart while the game server and its
    // players stayed up the whole time) - every rebuild would silently
    // reset the roster to empty despite people actually being online. Fix:
    // replay whatever's currently in the log file first (silently, no
    // Discord spam) to reconstruct the real current roster, then start
    // live-tailing for anything new. The log file gets truncated on every
    // game server restart, so "everything currently in the file" is
    // exactly the current session's history - no more, no less.
    this._replayExisting();

    // -F (not -f): re-opens by filename if the log gets truncated/replaced,
    // which happens on every container restart.
    this.proc = spawn("tail", ["-n", "0", "-F", this.logPath]);
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this._handleLine(line));
    this.proc.on("exit", (code) => {
      this.emit("error", new Error(`tail exited with code ${code}`));
    });
    this.proc.stderr.on("data", (chunk) => {
      console.error("tail stderr:", chunk.toString().trim());
    });
  }

  _replayExisting() {
    let lines;
    try {
      lines = readFileSync(this.logPath, "utf8").split("\n");
    } catch {
      // Doesn't exist yet - nothing to catch up on, tail -F will pick up
      // the file once the server creates it.
      return;
    }

    // Bounded to a recent window rather than the whole file: a long
    // uninterrupted session could accumulate a large log, and the further
    // back replay reaches, the more a single missed-parse edge case (see
    // the ambiguous-leave heuristic below) could leave a permanent "ghost"
    // entry rather than a self-correcting recent one. Window is relative
    // to the log's own last timestamp, not "now" by the bot's clock - see
    // parseTimestamp.
    let lastTimestamp = null;
    for (let i = lines.length - 1; i >= 0 && !lastTimestamp; i--) {
      lastTimestamp = parseTimestamp(lines[i]);
    }
    const cutoff = lastTimestamp
      ? new Date(lastTimestamp.getTime() - REPLAY_WINDOW_MS)
      : null;

    let current = null;
    for (const line of lines) {
      current = parseTimestamp(line) ?? current;
      // No timestamp seen yet, or no timestamp anywhere in the file at
      // all: skip rather than guess: real join/leave/version/join-code
      // lines always carry one in practice.
      if (!current || (cutoff && current < cutoff)) continue;
      this._handleLine(line, { silent: true });
    }

    console.log(
      `Replayed last ${REPLAY_WINDOW_MS / 3600000}h of log, roster now: ${
        this.currentNames().join(", ") || "(empty)"
      }`
    );
  }

  stop() {
    this.proc?.kill();
  }

  currentNames() {
    return [...this.players.values()];
  }

  // `silent: true` (used only for replaying existing log content at
  // startup - see _replayExisting) rebuilds internal state exactly as
  // normal, it just skips emitting events so catching up on history
  // already known to the server doesn't spam Discord with stale
  // announcements.
  _handleLine(line, { silent = false } = {}) {
    let m;

    if ((m = line.match(JOIN_RE))) {
      const [, name, zdoid] = m;
      // This line isn't unique to a fresh connection - it also fires on
      // respawn after death (and likely portal travel), reusing the same
      // zdoid each time (confirmed: it's the same "owner" id referenced by
      // ABANDONED_ZDO_RE below). Only treat it as an actual join if we
      // don't already believe this zdoid is connected - otherwise it's a
      // respawn, and re-announcing "joined the server" for it is wrong.
      const isRespawn = this.players.has(zdoid);
      this.players.set(zdoid, name);
      if (!isRespawn && !silent) {
        this.emit("join", { name, players: this.currentNames() });
      }
      return;
    }

    if ((m = line.match(ABANDONED_ZDO_RE))) {
      const zdoid = m[2];
      const name = this.players.get(zdoid);
      if (name) {
        this.players.delete(zdoid);
        this._recentRemovalAt = Date.now();
        if (!silent) this.emit("leave", { name, players: this.currentNames() });
      }
      return;
    }

    if (LEAVE_LOBBY_RE.test(line)) {
      // Already handled a moment ago via the precise zdo-owner match above.
      if (Date.now() - this._recentRemovalAt < 2000) return;

      if (this.players.size === 1) {
        // Unambiguous: only one player tracked, it must be them.
        const [[zdoid, name]] = this.players;
        this.players.delete(zdoid);
        if (!silent) this.emit("leave", { name, players: this.currentNames() });
      } else if (this.players.size > 1) {
        // 2+ players tracked with no precise attribution available. We
        // know *someone* left, just not who - guess the oldest-tracked
        // entry so the roster count stays right immediately (one leave
        // event = one decrement), rather than leaving it stale and
        // dumping the correction on the next COUNT_RE reconcile, which
        // would otherwise trim multiple unrelated entries at once. The
        // announcement stays generic since the guess may be wrong.
        const oldestKey = this.players.keys().next().value;
        this.players.delete(oldestKey);
        if (!silent) this.emit("leave", { name: null, players: this.currentNames() });
      }
      // size === 0: nothing tracked, nothing to do.
      return;
    }

    if ((m = line.match(COUNT_RE))) {
      this._reconcile(parseInt(m[1], 10));
      return;
    }

    if ((m = line.match(VERSION_RE))) {
      // Not silenced during replay: index.js's own version handler already
      // only announces on *change* (first observation is always recorded
      // quietly), so it's safe to emit unconditionally here - and doing so
      // is what lets a freshly (re)started bot learn the current version
      // from an already-running server instead of waiting for the next
      // actual game restart.
      this.emit("version", m[1]);
      return;
    }

    if ((m = line.match(JOIN_CODE_RE))) {
      // Same reasoning as version above.
      this.emit("joincode", m[1]);
      return;
    }
  }

  // Best-effort roster correction: if our tracked count is higher than what
  // the server just reported, drop the oldest-tracked entries down to size.
  // This can occasionally evict the wrong name when leaves race each other,
  // but keeps the *count* honest, which matters more for a small server.
  _reconcile(expected) {
    while (this.players.size > expected) {
      const oldestKey = this.players.keys().next().value;
      this.players.delete(oldestKey);
    }
  }
}
