// lib/helpers.js
// Owns: date formatting, timezone lookup, due-date parsing, Slack display name lookup,
//       traffic-light status emoji/label helpers.
// Does NOT own: analytics, error tracking, contact forms, counterparty resolution, or Slack handlers.

function formatDate(date, tz = 'America/New_York') {
  const d = new Date(date);
  // Validate tz — fall back to ET if Intl doesn't recognise it
  let resolvedTz = tz;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    resolvedTz = 'America/New_York';
  }
  const dateStr = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: resolvedTz,
  });
  // Include time if it's not exactly midnight UTC (i.e. a specific time was parsed)
  const hours = d.getUTCHours();
  const mins = d.getUTCMinutes();
  if (hours !== 0 || mins !== 0) {
    // Get short timezone abbreviation for display (e.g. "EST", "PST", "IST")
    const tzAbbrFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: resolvedTz,
      timeZoneName: 'short',
    });
    const tzAbbr = tzAbbrFormatter.formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '';
    const timeStr = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: resolvedTz,
    });
    return `${dateStr} at ${timeStr} ${tzAbbr}`;
  }
  return dateStr;
}

// Fetch a user's IANA timezone from their Slack profile.
// Returns the timezone string (e.g. 'America/Los_Angeles') or 'America/New_York' on failure.
async function getUserTimezone(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    return info.user?.tz || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

function parseDueDate(text) {
  // Try common patterns: "by Friday", "by April 25", "by 2026-04-25", "due tomorrow"
  // Use chrono-node for natural language parsing
  const chrono = require('chrono-node');
  const parsed = chrono.parse(text, new Date(), { forwardDate: true });

  if (parsed.length > 0) {
    const lastMatch = parsed[parsed.length - 1];
    const dueDate = lastMatch.start.date();
    // Strip the date portion (and leading "by"/"due"/"before") from description
    let description = text.substring(0, lastMatch.index)
      .replace(/\s*(by|due|before|until)\s*$/i, '')
      .trim();
    if (!description) description = text.trim();
    return { description, dueDate };
  }

  return { description: text.trim(), dueDate: null };
}

async function getUserName(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    const profile = info.user.profile;
    return profile.display_name || info.user.real_name || info.user.name || userId;
  } catch {
    return userId;
  }
}

// ---------------------------------------------------------------------------
// Traffic Light Status
// ---------------------------------------------------------------------------
function getStatusEmoji(dueDate) {
  if (!dueDate) return '⚪';
  const now = new Date();
  const due = new Date(dueDate);
  const hoursRemaining = (due - now) / (1000 * 60 * 60);
  if (hoursRemaining < 0) return '🔴';
  if (hoursRemaining <= 24) return '🟡';
  return '🟢';
}

function getStatusLabel(dueDate) {
  if (!dueDate) return '';
  const now = new Date();
  const due = new Date(dueDate);
  const hoursRemaining = (due - now) / (1000 * 60 * 60);
  if (hoursRemaining < 0) return 'overdue';
  if (hoursRemaining <= 24) return 'due soon';
  return '';
}

module.exports = { formatDate, getUserTimezone, parseDueDate, getUserName, getStatusEmoji, getStatusLabel };
