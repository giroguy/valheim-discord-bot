import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client, GatewayIntentBits, MessageFlags } from "discord.js";
import { LogWatcher } from "./logWatcher.js";
import {
  restartContainer,
  startContainer,
  stopContainer,
  getContainerStatus,
} from "./dockerControl.js";
import { commands, registerCommands } from "./commands.js";
import { memberHasRole, resolveRoleMention } from "./roles.js";
import { parseEnvFile } from "./envFile.js";
import { describeSchedule } from "./schedule.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_WEBHOOK_URL,
  ADMIN_ROLE_ID,
  UPDATE_MENTION_ROLE_ID,
  VALHEIM_CONTAINER_NAME = "valheim",
  VALHEIM_LOG_PATH = "/logs/valheim_server.log",
  VERSION_STATE_PATH = "/data/lastVersion.txt",
  JOIN_CODE_STATE_PATH = "/data/lastJoinCode.txt",
  VALHEIM_ENV_PATH = "/config/valheim.env",
} = process.env;

for (const [key, val] of Object.entries({
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_WEBHOOK_URL,
  ADMIN_ROLE_ID,
})) {
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Persisted across bot restarts so we only announce *changes*, not just
// "here's the version" every time the bot process comes back up.
let lastKnownVersion = existsSync(VERSION_STATE_PATH)
  ? readFileSync(VERSION_STATE_PATH, "utf8").trim() || null
  : null;

function saveVersion(version) {
  lastKnownVersion = version;
  try {
    writeFileSync(VERSION_STATE_PATH, version);
  } catch (err) {
    console.error("Failed to persist version state:", err);
  }
}

// Same persist-across-restarts approach as version, so /connect doesn't
// report "unknown" after a bot restart when the game server's session
// (and its join code) is still active and just wasn't re-announced.
let lastJoinCode = existsSync(JOIN_CODE_STATE_PATH)
  ? readFileSync(JOIN_CODE_STATE_PATH, "utf8").trim() || null
  : null;

function saveJoinCode(code) {
  lastJoinCode = code;
  try {
    writeFileSync(JOIN_CODE_STATE_PATH, code);
  } catch (err) {
    console.error("Failed to persist join code state:", err);
  }
}

// Read once at startup so the replay window (see LogWatcher) can convert
// log timestamps (which carry no timezone of their own) to real UTC for
// comparison against actual current time. Falls back to UTC if the env
// file isn't readable yet - safe (just means the replay cutoff may be off
// by a few hours until the mount is available), not a hard failure.
let gameServerTimezone = "UTC";
try {
  gameServerTimezone = parseEnvFile(VALHEIM_ENV_PATH).TZ || "UTC";
} catch (err) {
  console.warn(
    `Could not read ${VALHEIM_ENV_PATH} for timezone, defaulting to UTC:`,
    err.message
  );
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const watcher = new LogWatcher(VALHEIM_LOG_PATH, gameServerTimezone);

function mentionPrefix() {
  return resolveRoleMention(client, UPDATE_MENTION_ROLE_ID);
}

async function postMessage(content) {
  // Plain webhook POST, same mechanism as the existing curl-based hooks in
  // valheim-fullmonty.env - no bot channel permissions needed, since this
  // doesn't go through the gateway at all. The bot connection below is
  // only for slash commands.
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Webhook POST failed: ${res.status} ${await res.text()}`);
  }
}

// Without this, any error discord.js emits on the client (gateway hiccups,
// a failed API call it couldn't attribute elsewhere, etc.) is an
// unhandled 'error' event - Node's default behavior for those is to
// throw and crash the whole process. Logging it here is what keeps a
// transient Discord-side issue from taking down player tracking,
// webhook posting, and everything else along with it.
client.on("error", (err) => {
  console.error("Discord client error:", err);
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands({
      token: DISCORD_BOT_TOKEN,
      clientId: DISCORD_CLIENT_ID,
      guildId: DISCORD_GUILD_ID,
    });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
  watcher.start();
  console.log(`Watching ${VALHEIM_LOG_PATH} for player/version events.`);
});

watcher.on("join", ({ name }) => {
  postMessage(`**${name}** joined the server.`).catch(console.error);
});

watcher.on("leave", ({ name }) => {
  const who = name ? `**${name}**` : "A player";
  postMessage(`${who} disconnected.`).catch(console.error);
});

watcher.on("version", (version) => {
  if (lastKnownVersion === null) {
    // First observation since the bot started tracking - record silently,
    // don't announce (this is not necessarily a fresh update).
    saveVersion(version);
    return;
  }
  if (version !== lastKnownVersion) {
    const previous = lastKnownVersion;
    saveVersion(version);
    postMessage(
      `${mentionPrefix()}Server updated: \`${previous}\` → \`${version}\``
    ).catch(console.error);
  }
});

watcher.on("joincode", (code) => {
  if (lastJoinCode === null) {
    // First observation since the bot started tracking - record silently.
    saveJoinCode(code);
    return;
  }
  if (code !== lastJoinCode) {
    saveJoinCode(code);
    postMessage(`New join code: \`${code}\``).catch(console.error);
  }
});

watcher.on("error", (err) => {
  console.error("Log watcher error:", err);
  postMessage(
    "⚠️ Lost track of the server log — player list may be out of sync until the bot restarts."
  ).catch(console.error);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleCommand(interaction);
  } catch (err) {
    // Whatever went wrong (a Discord API hiccup like Unknown Interaction,
    // a bug in a handler, anything) - log it and stop, instead of letting
    // it become an unhandled rejection that crashes the whole bot. One
    // failed command reply should never take down player tracking,
    // webhook posting, and every other in-flight thing with it.
    console.error(`Error handling /${interaction.commandName}:`, err);
    try {
      const payload = { content: "Something went wrong handling that command." };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // Interaction may genuinely be unrecoverable at this point (e.g.
      // the same "Unknown interaction" case) - nothing more to do.
    }
  }
});

// Shared by restart/start/stop: role check first (in-memory, instant) so
// we know whether the reply needs to be ephemeral before acking -
// ephemeral is set at defer time, can't be changed on a later edit.
// Returns true if the caller is allowed and the interaction is deferred;
// false means an ephemeral "no permission" reply was already sent and the
// caller should stop.
async function requireAdmin(interaction) {
  const hasRole = memberHasRole(interaction.member, ADMIN_ROLE_ID);
  await interaction.deferReply(
    hasRole ? {} : { flags: MessageFlags.Ephemeral }
  );
  if (!hasRole) {
    await interaction.editReply("You don't have permission to do that.");
    return false;
  }
  return true;
}

// Shared by restart/start/stop/status: a 404 means the container doesn't
// exist at all (e.g. removed via `docker compose down`, not just
// stopped) - dockerode's start/stop/restart can't recreate that, only
// the host running `docker compose up` can, so say so plainly instead of
// a generic failure. Every other error's own message gets surfaced too -
// no more "check bot logs" as the only signal for what actually happened.
function describeDockerError(err) {
  if (err.statusCode === 404) {
    return "Server container doesn't exist — it needs to be recreated on the host (`docker compose up -d`), not something I can do remotely.";
  }
  return `Error talking to the server container: ${err.message}`;
}

async function handleCommand(interaction) {
  if (interaction.commandName === "restart") {
    if (!(await requireAdmin(interaction))) return;
    try {
      const status = await getContainerStatus(VALHEIM_CONTAINER_NAME);
      if (status.running) {
        await interaction.editReply(`${mentionPrefix()}Restarting the server...`);
        await restartContainer(VALHEIM_CONTAINER_NAME);
      } else {
        // restart() would actually still work here (confirmed: Docker
        // starts a stopped container on restart, no error) - but saying
        // "restarting" when it was actually off is exactly the confusing
        // messaging this command used to have. Say what's really happening.
        await interaction.editReply(
          `${mentionPrefix()}Server was stopped — starting it now...`
        );
        await startContainer(VALHEIM_CONTAINER_NAME);
      }
    } catch (err) {
      console.error("Restart failed:", err);
      await interaction.editReply(describeDockerError(err));
    }
    return;
  }

  if (interaction.commandName === "start") {
    if (!(await requireAdmin(interaction))) return;
    try {
      const status = await getContainerStatus(VALHEIM_CONTAINER_NAME);
      if (status.running) {
        await interaction.editReply("Server is already running.");
        return;
      }
      await interaction.editReply(`${mentionPrefix()}Starting the server...`);
      await startContainer(VALHEIM_CONTAINER_NAME);
    } catch (err) {
      console.error("Start failed:", err);
      await interaction.editReply(describeDockerError(err));
    }
    return;
  }

  if (interaction.commandName === "stop") {
    if (!(await requireAdmin(interaction))) return;
    try {
      const status = await getContainerStatus(VALHEIM_CONTAINER_NAME);
      if (!status.running) {
        await interaction.editReply("Server is already stopped.");
        return;
      }
      await interaction.editReply(`${mentionPrefix()}Stopping the server...`);
      await stopContainer(VALHEIM_CONTAINER_NAME);
    } catch (err) {
      console.error("Stop failed:", err);
      await interaction.editReply(describeDockerError(err));
    }
    return;
  }

  // Every other command: ack immediately, before any other work. This
  // only needs to beat Discord's 3-second window (it's just an ack, no
  // content yet), and buys up to 15 minutes for the real reply via
  // editReply below - makes every command resistant to a transient
  // delay (ours or Discord's) instead of racing a 3-second budget every
  // time. Confirmed necessary in production: /players (whose own logic
  // is a trivial in-memory read, nothing slow) still hit an "Unknown
  // interaction" failure once - see README's Crash resilience section.
  await interaction.deferReply();

  if (interaction.commandName === "help") {
    // Built from the same `commands` list used to register them, so this
    // can't drift out of sync when a command gets added/renamed.
    const lines = commands.map((c) => `\`/${c.name}\` — ${c.description}`);
    await interaction.editReply(lines.join("\n"));
    return;
  }

  if (interaction.commandName === "status") {
    try {
      const status = await getContainerStatus(VALHEIM_CONTAINER_NAME);
      if (!status.running) {
        await interaction.editReply(`Server is **offline** (${status.status}).`);
        return;
      }
      const names = watcher.currentNames();
      await interaction.editReply(
        `Server is **online**. ` +
          (names.length
            ? `${names.length} player(s): ${names.join(", ")}`
            : "No players currently online.")
      );
    } catch (err) {
      console.error("Failed to get container status:", err);
      await interaction.editReply(describeDockerError(err));
    }
    return;
  }

  if (interaction.commandName === "players") {
    // "No players online" is ambiguous between "server's up but empty"
    // and "server's off entirely" - check status first so it's never
    // read as the server being up when it isn't.
    try {
      const status = await getContainerStatus(VALHEIM_CONTAINER_NAME);
      if (!status.running) {
        await interaction.editReply(
          `Server is currently **offline** (${status.status}).`
        );
        return;
      }
    } catch (err) {
      console.error("Failed to get container status:", err);
      await interaction.editReply(describeDockerError(err));
      return;
    }
    const names = watcher.currentNames();
    await interaction.editReply(
      names.length
        ? `**${names.length}** player(s) online: ${names.join(", ")}`
        : "No players currently online."
    );
    return;
  }

  if (interaction.commandName === "version") {
    await interaction.editReply(
      lastKnownVersion
        ? `Server is running Valheim version \`${lastKnownVersion}\``
        : "Version not yet observed since the bot started."
    );
    return;
  }

  if (interaction.commandName === "schedule") {
    try {
      const env = parseEnvFile(VALHEIM_ENV_PATH);
      const tz = env.TZ;
      const lines = [
        describeSchedule(
          "Auto-update",
          env.AUTO_UPDATE,
          env.AUTO_UPDATE_SCHEDULE,
          tz
        ),
        describeSchedule(
          "Auto-backup",
          env.AUTO_BACKUP,
          env.AUTO_BACKUP_SCHEDULE,
          tz
        ),
        describeSchedule(
          "Scheduled restart",
          env.SCHEDULED_RESTART,
          env.SCHEDULED_RESTART_SCHEDULE,
          tz
        ),
      ];
      await interaction.editReply(lines.join("\n"));
    } catch (err) {
      console.error("Failed to read schedule config:", err);
      await interaction.editReply(
        "Couldn't read the server's schedule config right now."
      );
    }
    return;
  }

  if (interaction.commandName === "connect") {
    await interaction.editReply(
      lastJoinCode
        ? `Current join code: \`${lastJoinCode}\``
        : "Join code not yet observed since the bot started."
    );
    return;
  }
}

client.login(DISCORD_BOT_TOKEN);

function shutdown() {
  watcher.stop();
  client.destroy();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
