import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client, GatewayIntentBits } from "discord.js";
import { LogWatcher } from "./logWatcher.js";
import { restartContainer } from "./dockerControl.js";
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const watcher = new LogWatcher(VALHEIM_LOG_PATH);

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
        await interaction.reply({ ...payload, ephemeral: true });
      }
    } catch {
      // Interaction may genuinely be unrecoverable at this point (e.g.
      // the same "Unknown interaction" case) - nothing more to do.
    }
  }
});

async function handleCommand(interaction) {
  if (interaction.commandName === "help") {
    // Built from the same `commands` list used to register them, so this
    // can't drift out of sync when a command gets added/renamed.
    const lines = commands.map((c) => `\`/${c.name}\` — ${c.description}`);
    await interaction.reply(lines.join("\n"));
    return;
  }

  if (interaction.commandName === "players") {
    const names = watcher.currentNames();
    await interaction.reply(
      names.length
        ? `**${names.length}** player(s) online: ${names.join(", ")}`
        : "No players currently online."
    );
    return;
  }

  if (interaction.commandName === "version") {
    await interaction.reply(
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
      await interaction.reply(lines.join("\n"));
    } catch (err) {
      console.error("Failed to read schedule config:", err);
      await interaction.reply(
        "Couldn't read the server's schedule config right now."
      );
    }
    return;
  }

  if (interaction.commandName === "connect") {
    await interaction.reply(
      lastJoinCode
        ? `Current join code: \`${lastJoinCode}\``
        : "Join code not yet observed since the bot started."
    );
    return;
  }

  if (interaction.commandName === "restart") {
    const hasRole = memberHasRole(interaction.member, ADMIN_ROLE_ID);
    if (!hasRole) {
      await interaction.reply({
        content: "You don't have permission to do that.",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply(`${mentionPrefix()}Restarting the server...`);
    try {
      await restartContainer(VALHEIM_CONTAINER_NAME);
    } catch (err) {
      console.error("Restart failed:", err);
      await interaction.followUp("Restart failed — check bot logs.");
    }
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
