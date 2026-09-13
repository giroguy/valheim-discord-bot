import cronstrue from "cronstrue";
import { CronExpressionParser } from "cron-parser";

// Matches Odin's own parse_bool_env semantics (confirmed against its Rust
// source), so "enabled" here means the same thing it would inside the
// valheim container itself.
export function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

// e.g. "Auto-update: at 05:00 AM — next <t:1234567890:R>"
// The <t:...:R> is Discord's native relative-timestamp format - renders as
// a live-updating "in 14 hours" in the client, correctly adjusted to each
// viewer's own timezone, so no need to hand-format relative time here.
export function describeSchedule(label, enabledValue, cronExpr, timezone) {
  if (!isEnabled(enabledValue)) {
    return `${label}: disabled`;
  }
  if (!cronExpr) {
    return `${label}: enabled (no schedule configured)`;
  }

  try {
    const description = cronstrue.toString(cronExpr);
    const interval = CronExpressionParser.parse(cronExpr, {
      tz: timezone || "UTC",
    });
    const unixSeconds = Math.floor(interval.next().toDate().getTime() / 1000);
    return `${label}: ${description} — next <t:${unixSeconds}:R>`;
  } catch (err) {
    console.error(`Failed to parse cron "${cronExpr}" for ${label}:`, err);
    return `${label}: \`${cronExpr}\` (couldn't parse)`;
  }
}
