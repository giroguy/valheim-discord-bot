// Lets ADMIN_ROLE_ID / UPDATE_MENTION_ROLE_ID be set as either a role name
// (e.g. "dev") or a numeric role ID snowflake - matching whichever the
// config actually contains, so setting this up doesn't require enabling
// Discord's Developer Mode just to copy an ID.

function roleMatches(role, value) {
  if (!role || !value) return false;
  return role.id === value || role.name.toLowerCase() === value.toLowerCase();
}

export function memberHasRole(member, value) {
  if (!member || !value) return false;
  return member.roles.cache.some((r) => roleMatches(r, value));
}

// For proactive messages (join/leave/version-change), there's no
// interaction to pull a guild from, so this assumes a single-server bot
// and uses whichever guild the bot is in.
export function resolveRoleMention(client, value) {
  if (!value) return "";
  const normalized = value.trim().toLowerCase();
  if (normalized === "@here") return "@here ";
  if (normalized === "@everyone") return "@everyone ";

  const guild = client.guilds.cache.first();
  if (!guild) {
    console.warn("No guild available to resolve mention target:", value);
    return "";
  }
  const role = guild.roles.cache.find((r) => roleMatches(r, value));
  if (!role) {
    console.warn(`Could not find a role matching "${value}" to mention.`);
    return "";
  }
  return `<@&${role.id}> `;
}
