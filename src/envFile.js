import { readFileSync } from "node:fs";

// Minimal dotenv-style parser for reading valheim-fullmonty.env directly
// (mounted read-only - see ENV_FILE_PATH in index.js). Only needs to
// handle plain KEY=value lines, values with a leading space before them
// (e.g. "AUTO_UPDATE= 1"), and optionally single/double-quoted values -
// that covers everything actually used by /schedule. Deliberately not a
// full dotenv implementation (no multi-line values, no $VAR expansion -
// PRE_BOOTSTRAP_HOOK etc. aren't needed here and are more complex than
// this needs to handle).
export function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const result = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.at(-1) === '"') ||
        (value[0] === "'" && value.at(-1) === "'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
