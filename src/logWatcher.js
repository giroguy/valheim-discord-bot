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

// Timezone-correct wall-clock -> UTC conversion, done via Intl numeric
// formatting only (no Date string-parsing, which is environment-dependent
// - an earlier version of this used a string-parse trick that silently
// gave wrong results depending on the *runtime's own* system timezone).
function getTimezoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUTC - date.getTime();
}

function zonedTimeToUtc(y, mo, d, h, mi, s, timeZone) {
  const utcGuess = Date.UTC(y, mo, d, h, mi, s);
  const offset = getTimezoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function parseTimestamp(line, timeZone) {
  const m = line.match(TIMESTAMP_RE);
  if (!m) return null;
  const [, month, day, year, hour, minute, second] = m;
  // The log's timestamps carry no timezone of their own - they're in
  // whatever TZ the game server container is configured with. Converting
  // properly (rather than comparing naively, or not comparing against
  // wall-clock at all) is what lets the replay window use actual current
  // time as its cutoff: a log that's gone stale (nothing appended in
  // hours) correctly stops being "recent" instead of the window staying
  // frozen relative to the log's own last-ever timestamp forever.
  return zonedTimeToUtc(year, month - 1, day, hour, minute, second, timeZone);
}

const REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export class LogWatcher extends EventEmitter {
  constructor(logPath, timeZone = "UTC") {
    super();
    this.logPath = logPath;
    this.timeZone = timeZone;
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
    // entry rather than a self-correcting recent one. Cutoff is actual
    // wall-clock time, not relative to the log's own last timestamp - a
    // log that's gone stale (nothing appended in hours, e.g. a dev/test
    // log nobody's writing to anymore) needs to stop being "recent" as
    // real time passes, not stay frozen in its own last-observed moment
    // forever. Confirmed this was a real bug, not just theoretical: it's
    // exactly what caused old test join-code lines to replay and
    // re-announce on every subsequent restart of a stale local test log,
    // days after they were first written.
    const cutoff = new Date(Date.now() - REPLAY_WINDOW_MS);

    let current = null;
    for (const line of lines) {
      current = parseTimestamp(line, this.timeZone) ?? current;
      // No timestamp seen yet, or no timestamp anywhere in the file at
      // all: skip rather than guess: real join/leave/version/join-code
      // lines always carry one in practice.
      if (!current || current < cutoff) continue;
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
      if (!isRespawn) {
        // A fresh connection always gets a brand-new zdoid, never reusing
        // an old one - so if this name is already tracked under a
        // *different* zdoid, that old entry must be stale (most likely
        // the ambiguous-leave heuristic below guessing wrong and evicting
        // someone else instead of this player when they actually
        // disconnected). The same person can't have two live sessions at
        // once, so it's always safe to drop the stale entry rather than
        // let the roster show the same name twice.
        for (const [oldZdoid, oldName] of this.players) {
          if (oldName === name && oldZdoid !== zdoid) {
            this.players.delete(oldZdoid);
          }
        }
      }
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
