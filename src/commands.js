import { REST, Routes, SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("players")
    .setDescription("List players currently on the Valheim server"),
  new SlashCommandBuilder()
    .setName("version")
    .setDescription("Show the Valheim server's currently running version"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show whether the server is online or offline"),
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the Valheim server container (admin only)"),
  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start the Valheim server container if it's stopped (admin only)"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the Valheim server container (admin only)"),
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Show the next scheduled auto-update/auto-backup times"),
  new SlashCommandBuilder()
    .setName("connect")
    .setDescription("Get the current join code (works for Steam/Xbox/PlayStation)"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("List available commands"),
].map((c) => c.toJSON());

export async function registerCommands({ token, clientId, guildId }) {
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
}
