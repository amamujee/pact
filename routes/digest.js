// routes/digest.js
// Owns: weekly standup digest — scheduled send, Block Kit builder, inline action handlers.
// Does NOT own: pact creation or regular reminders.

const digestDb = require('../db/digest');
const pactDb = require('../db/pacts');

// ---------------------------------------------------------------------------
// Utilities (injected from server.js at init to avoid circular require)
// ---------------------------------------------------------------------------
let _formatDate, _getUserTimezone, _getTeamTier, _planBadge, _completePact;

function init({ formatDate, getUserTimezone, getTeamTier, planBadge, completePact }) {
  _formatDate = formatDate;
  _getUserTimezone = getUserTimezone;
  _getTeamTier = getTeamTier;
  _planBadge = planBadge;
  _completePact = completePact;
}

// ---------------------------------------------------------------------------
// Block Kit builder
// ---------------------------------------------------------------------------

function statusEmoji(dueDate) {
  if (!dueDate) return '⚪';
  const diff = (new Date(dueDate) - Date.now()) / 3600000;
  if (diff < 0) return '🔴';
  if (diff <= 24) return '🟡';
  return '🟢';
}

/**
 * Build the weekly standup digest blocks for a user.
 * @param {Object} data - { activePacts, overduePacts, completedThisWeek }
 * @param {string} userId
 * @param {string} userTz  - IANA timezone string
 * @param {string} plan    - access-plan label
 */
function buildDigestBlocks(data, userId, userTz, plan) {
  const { activePacts, overduePacts, completedThisWeek } = data;
  const kept = completedThisWeek.length;
  const total = activePacts.length + kept;
  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📋 Weekly Pact Standup', emoji: true }
  });

  // Promise score
  const scoreText = total > 0
    ? `*Promise score this week:* ${kept}/${total} kept ✅`
    : `*No pact activity this week yet.* Get started with \`/pact [task] by [date]\``;

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: scoreText }
  });
  blocks.push({ type: 'divider' });

  // Completed this week
  if (completedThisWeek.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*✅ Completed this week (${completedThisWeek.length}):*\n` +
          completedThisWeek.map(p => `• _${p.description}_`).join('\n')
      }
    });
    blocks.push({ type: 'divider' });
  }

  // Overdue pacts (highlighted)
  if (overduePacts.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔴 Overdue (${overduePacts.length}) — needs attention:*`
      }
    });

    for (const pact of overduePacts.slice(0, 5)) {
      const dueStr = pact.due_date ? _formatDate(new Date(pact.due_date), userTz) : 'No due date';
      const isCreator = pact.creator_slack_id === userId;
      const partnerStr = isCreator && pact.counterparty_slack_id
        ? ` · with <@${pact.counterparty_slack_id}>`
        : !isCreator ? ` · from <@${pact.creator_slack_id}>` : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔴  *"${pact.description}"*\n      Due: ${dueStr}${partnerStr}`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Complete', emoji: true },
          action_id: 'digest_complete_pact',
          value: String(pact.id),
          style: 'primary'
        }
      });
    }
    blocks.push({ type: 'divider' });
  }

  // Active (non-overdue) pacts
  const nonOverdueActive = activePacts.filter(p => {
    if (!p.due_date) return true;
    return new Date(p.due_date) >= Date.now();
  });

  if (nonOverdueActive.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🟢 Active pacts (${nonOverdueActive.length}):*`
      }
    });

    for (const pact of nonOverdueActive.slice(0, 8)) {
      const emoji = statusEmoji(pact.due_date);
      const dueStr = pact.due_date ? _formatDate(new Date(pact.due_date), userTz) : 'No due date';
      const isCreator = pact.creator_slack_id === userId;
      const partnerStr = isCreator && pact.counterparty_slack_id
        ? ` · with <@${pact.counterparty_slack_id}>`
        : !isCreator ? ` · from <@${pact.creator_slack_id}>` : '';

      // Encode pact ID + userId for the extend button
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji}  *"${pact.description}"*\n      Due: ${dueStr}${partnerStr}`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Complete', emoji: true },
          action_id: 'digest_complete_pact',
          value: String(pact.id),
          style: 'primary'
        }
      });
    }
  }

  if (activePacts.length === 0 && completedThisWeek.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No active pacts right now. Create one with `/pact [task] by [date]`.'
      }
    });
  }

  // Footer: snooze + badge
  const badge = _planBadge(plan || 'free');
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'digest_snooze',
        text: { type: 'plain_text', text: '🔕 Snooze next week', emoji: true },
        value: 'snooze_1w'
      },
      {
        type: 'button',
        action_id: 'digest_opt_out',
        text: { type: 'plain_text', text: '⏹ Turn off digest', emoji: true },
        value: 'opt_out'
      }
    ]
  });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Weekly pact standup · ${badge} · Use \`/pact settings\` to adjust frequency`
    }]
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Send digest to a single user
// ---------------------------------------------------------------------------

async function sendDigestToUser(slackClient, userId, teamId) {
  try {
    const [data, userTz] = await Promise.all([
      digestDb.getUserDigestData(userId),
      _getUserTimezone(slackClient, userId),
    ]);

    // Skip if no active pacts and no completions this week
    if (data.activePacts.length === 0 && data.completedThisWeek.length === 0) {
      console.log(`[digest] Skipping ${userId} — no activity`);
      return;
    }

    const plan = teamId ? await _getTeamTier(teamId) : 'free';
    const blocks = buildDigestBlocks(data, userId, userTz, plan);

    const dmResult = await slackClient.conversations.open({ users: userId });
    const dmChannelId = dmResult.channel.id;

    await slackClient.chat.postMessage({
      channel: dmChannelId,
      blocks,
      text: `Weekly pact standup: ${data.activePacts.length} active, ${data.completedThisWeek.length} completed this week.`
    });

    await digestDb.markDigestSent(userId, teamId);
    console.log(`[digest] Sent to ${userId} (${data.activePacts.length} active, ${data.completedThisWeek.length} completed)`);
  } catch (err) {
    console.error(`[digest] Failed for user ${userId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Check if a user is due for their weekly digest right now.
 * "Due" = current local day matches send_day AND local hour matches send_hour.
 * We poll every 30 min and fire within a ±25 min window of the scheduled hour.
 */
function isDigestDue(row) {
  const tz = row.timezone || 'America/New_York';
  const now = new Date();

  let localDay, localHour;
  try {
    // Intl gives us local day-of-week and hour
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayStr = parts.find(p => p.type === 'weekday')?.value;
    localDay = weekdays.indexOf(dayStr);

    const hourStr = parts.find(p => p.type === 'hour')?.value;
    localHour = parseInt(hourStr, 10);
    if (localHour === 24) localHour = 0; // some locales use 24 for midnight
  } catch {
    // Fallback to UTC
    localDay = now.getUTCDay();
    localHour = now.getUTCHours();
  }

  const targetDay = row.send_day; // 0=Sun…6=Sat, default 1=Mon
  const targetHour = row.send_hour; // 0–23, default 9

  return localDay === targetDay && localHour === targetHour;
}

async function runWeeklyDigestCheck(slackClient) {
  console.log('[digest] Running weekly check...');
  try {
    const users = await digestDb.getUsersDueForWeeklyDigest();
    if (users.length === 0) {
      console.log('[digest] No users due for digest.');
      return;
    }

    const dueNow = users.filter(isDigestDue);
    console.log(`[digest] ${dueNow.length}/${users.length} users due right now`);

    for (const user of dueNow) {
      await sendDigestToUser(slackClient, user.user_id, user.team_id);
    }
  } catch (err) {
    console.error('[digest] Weekly check error:', err.message);
  }
}

function startWeeklyDigestScheduler(slackClient) {
  if (!slackClient) return;

  // Poll every 30 minutes. Fires when local day/hour matches user preference.
  const INTERVAL = 30 * 60 * 1000;
  setInterval(() => runWeeklyDigestCheck(slackClient), INTERVAL);

  // Also run 20 seconds after startup to catch any immediate due digests
  setTimeout(() => runWeeklyDigestCheck(slackClient), 20000);

  console.log('[digest] Weekly scheduler started (30 min poll)');
}

// ---------------------------------------------------------------------------
// Action handlers (registered in server.js)
// ---------------------------------------------------------------------------

/**
 * ✅ Complete button from digest DM.
 * action_id: digest_complete_pact, value: pact ID (string)
 */
async function handleDigestComplete({ ack, body, client, action }, tracker = null) {
  await ack();
  const userId = body.user.id;
  const pactId = parseInt(action.value);
  if (!pactId) return;

  const pact = await digestDb.getPactById(pactId);
  if (!pact) return;

  // completePact posts to pact.channel_id; DM fallback not needed here
  const dmResult = await client.conversations.open({ users: userId });
  const dmChannelId = dmResult.channel.id;

  await _completePact(pactId, userId, dmChannelId, client, null, tracker);
}

/**
 * 🔕 Snooze digest for 1 week.
 * action_id: digest_snooze
 */
async function handleDigestSnooze({ ack, body, client }) {
  await ack();
  const userId = body.user.id;
  const teamId = body.team?.id || body.user?.team_id;
  if (!teamId) return;

  const snoozeUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await digestDb.updateDigestPrefs(userId, teamId, { digest_snoozed_until: snoozeUntil });

  // Confirm with ephemeral
  const dmResult = await client.conversations.open({ users: userId });
  await client.chat.postEphemeral({
    channel: dmResult.channel.id,
    user: userId,
    text: '🔕 Got it — I\'ll skip next week\'s standup. Use `/pact settings` to change this.'
  });
}

/**
 * ⏹ Turn off digest entirely.
 * action_id: digest_opt_out
 */
async function handleDigestOptOut({ ack, body, client }) {
  await ack();
  const userId = body.user.id;
  const teamId = body.team?.id || body.user?.team_id;
  if (!teamId) return;

  await digestDb.updateDigestPrefs(userId, teamId, { digest_opt_out: true });

  const dmResult = await client.conversations.open({ users: userId });
  await client.chat.postEphemeral({
    channel: dmResult.channel.id,
    user: userId,
    text: '⏹ Weekly standup digest turned off. You can re-enable it with `/pact settings`.'
  });
}

// ---------------------------------------------------------------------------
// /pact settings digest sub-handler
// ---------------------------------------------------------------------------

/**
 * Show digest settings card.
 * Called from the /pact settings command handler in server.js.
 */
async function handleDigestSettingsView(userId, teamId, respond) {
  const prefs = await digestDb.getOrCreateDigestPrefs(userId, teamId);
  const freqLabel = prefs.frequency === 'daily' ? 'Daily' : prefs.frequency === 'off' ? 'Off' : 'Weekly (Monday 9am)';
  const status = prefs.digest_opt_out ? '❌ Off' : prefs.digest_snoozed_until && new Date(prefs.digest_snoozed_until) > new Date() ? '🔕 Snoozed until next week' : '✅ On';

  await respond({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📋 Weekly Standup Digest*\nStatus: ${status}\nFrequency: ${freqLabel}\n\nGet a weekly DM with your pact summary, promise score, and one-click complete buttons.`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'digest_settings_enable',
            text: { type: 'plain_text', text: '✅ Enable weekly digest', emoji: true },
            value: 'enable',
            style: 'primary'
          },
          {
            type: 'button',
            action_id: 'digest_opt_out',
            text: { type: 'plain_text', text: '⏹ Turn off', emoji: true },
            value: 'opt_out'
          }
        ]
      }
    ],
    text: `Weekly digest: ${status}`
  });
}

/**
 * Enable digest from settings card.
 * action_id: digest_settings_enable
 */
async function handleDigestSettingsEnable({ ack, body, client }) {
  await ack();
  const userId = body.user.id;
  const teamId = body.team?.id || body.user?.team_id;
  if (!teamId) return;

  const userTz = await _getUserTimezone(client, userId);
  await digestDb.getOrCreateDigestPrefs(userId, teamId, userTz);
  await digestDb.updateDigestPrefs(userId, teamId, {
    digest_opt_out: false,
    digest_snoozed_until: null,
    frequency: 'weekly',
    timezone: userTz,
  });

  const dmResult = await client.conversations.open({ users: userId });
  await client.chat.postEphemeral({
    channel: dmResult.channel.id,
    user: userId,
    text: '✅ Weekly standup digest enabled! You\'ll get a DM every Monday at 9am in your timezone.'
  });
}

// ---------------------------------------------------------------------------
// Daily morning digest card builder
// ---------------------------------------------------------------------------

/**
 * Build compact Block Kit blocks for the daily morning "Today in Pact" card.
 * Designed to be glanceable in one screen — concise, actionable.
 * @param {Object} data - { pactsDueToday, overduePacts, upcomingPacts, allActive }
 * @param {string} userId
 * @param {string} userTz  - IANA timezone string
 * @param {string} plan    - access-plan label
 */
function buildDailyMorningBlocks(data, userId, userTz, plan) {
  const { pactsDueToday, overduePacts, upcomingPacts, allActive } = data;
  const blocks = [];
  const todayCount = pactsDueToday.length;
  const overdueCount = overduePacts.length;

  // Header — vary tone based on urgency
  let headerText;
  if (overdueCount > 0 && todayCount > 0) {
    headerText = `🌅 Good morning — ${todayCount} pact${todayCount !== 1 ? 's' : ''} due today, ${overdueCount} overdue`;
  } else if (overdueCount > 0) {
    headerText = `🔴 ${overdueCount} overdue pact${overdueCount !== 1 ? 's' : ''} need${overdueCount === 1 ? 's' : ''} attention`;
  } else if (todayCount > 0) {
    headerText = `🌅 Good morning — ${todayCount} pact${todayCount !== 1 ? 's' : ''} due today`;
  } else if (allActive.length > 0) {
    headerText = `🌅 Good morning — nothing due today`;
  } else {
    // No active pacts — shouldn't send, but safe fallback
    headerText = '🌅 Good morning — no open pacts';
  }

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: headerText, emoji: true }
  });

  // Overdue section (max 5)
  if (overduePacts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔴 Overdue:*` }
    });
    for (const pact of overduePacts.slice(0, 5)) {
      const dueStr = pact.due_date ? _formatDate(new Date(pact.due_date), userTz) : 'No due date';
      const isCreator = pact.creator_slack_id === userId;
      const partnerStr = isCreator && pact.counterparty_slack_id
        ? ` · with <@${pact.counterparty_slack_id}>`
        : !isCreator ? ` · from <@${pact.creator_slack_id}>` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔴 *"${pact.description}"*\nWas due: ${dueStr}${partnerStr}`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Complete', emoji: true },
          action_id: 'digest_complete_pact',
          value: String(pact.id),
          style: 'primary'
        }
      });
    }
    if (overduePacts.length > 5) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_+${overduePacts.length - 5} more overdue — use \`/pacts\` to see all_` }]
      });
    }
    blocks.push({ type: 'divider' });
  }

  // Due today section (max 5)
  if (pactsDueToday.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📅 Due today:*` }
    });
    for (const pact of pactsDueToday.slice(0, 5)) {
      const dueStr = pact.due_date ? _formatDate(new Date(pact.due_date), userTz) : 'Today';
      const isCreator = pact.creator_slack_id === userId;
      const partnerStr = isCreator && pact.counterparty_slack_id
        ? ` · with <@${pact.counterparty_slack_id}>`
        : !isCreator ? ` · from <@${pact.creator_slack_id}>` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🟡 *"${pact.description}"*\nDue: ${dueStr}${partnerStr}`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Complete', emoji: true },
          action_id: 'digest_complete_pact',
          value: String(pact.id),
          style: 'primary'
        }
      });
    }
    if (pactsDueToday.length > 5) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_+${pactsDueToday.length - 5} more due today — use \`/pacts\` to see all_` }]
      });
    }
    if (upcomingPacts.length > 0) blocks.push({ type: 'divider' });
  }

  // "Coming up this week" — compact list, no buttons (context only)
  if (upcomingPacts.length > 0 && (pactsDueToday.length > 0 || overduePacts.length > 0)) {
    const upcomingLines = upcomingPacts.slice(0, 3).map(p => {
      const dueStr = p.due_date ? _formatDate(new Date(p.due_date), userTz) : '';
      return `• _"${p.description}"_ ${dueStr ? `— ${dueStr}` : ''}`;
    }).join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🟢 Coming up this week:*\n${upcomingLines}${upcomingPacts.length > 3 ? `\n_+${upcomingPacts.length - 3} more_` : ''}`
      }
    });
  }

  // "Nothing due today" state
  if (pactsDueToday.length === 0 && overduePacts.length === 0) {
    const upcomingCount = upcomingPacts.length;
    const text = upcomingCount > 0
      ? `No pacts due today. You have ${upcomingCount} coming up this week.\n` +
        upcomingPacts.slice(0, 3).map(p => {
          const dueStr = p.due_date ? _formatDate(new Date(p.due_date), userTz) : '';
          return `• _"${p.description}"_ ${dueStr ? `— ${dueStr}` : ''}`;
        }).join('\n')
      : 'No pacts due today or this week. Keep making promises with `/pact [task] by [date]`.';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  // Footer
  const badge = _planBadge(plan || 'free');
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'digest_snooze',
        text: { type: 'plain_text', text: '🔕 Snooze 1 week', emoji: true },
        value: 'snooze_1w'
      },
      {
        type: 'button',
        action_id: 'digest_opt_out',
        text: { type: 'plain_text', text: '⏹ Turn off', emoji: true },
        value: 'opt_out'
      }
    ]
  });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Daily morning digest · ${badge} · Use \`/pact settings\` to adjust`
    }]
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Send daily morning digest to a single user
// ---------------------------------------------------------------------------

async function sendDailyDigestToUser(slackClient, userId, teamId) {
  try {
    const [data, userTz] = await Promise.all([
      digestDb.getUserDailyDigestData(userId),
      _getUserTimezone(slackClient, userId),
    ]);

    // Skip if no active pacts (don't spam empty cards)
    if (data.allActive.length === 0) {
      return;
    }

    const plan = teamId ? await _getTeamTier(teamId) : 'free';
    const blocks = buildDailyMorningBlocks(data, userId, userTz, plan);

    const dmResult = await slackClient.conversations.open({ users: userId });
    const dmChannelId = dmResult.channel.id;

    const overdueCount = data.overduePacts.length;
    const todayCount = data.pactsDueToday.length;
    const fallbackText = overdueCount > 0
      ? `🔴 ${overdueCount} overdue + ${todayCount} due today — Good morning from Pact`
      : todayCount > 0
        ? `📅 ${todayCount} pact${todayCount !== 1 ? 's' : ''} due today — Good morning from Pact`
        : `🌅 Good morning — ${data.allActive.length} active pact${data.allActive.length !== 1 ? 's' : ''} in progress`;

    await slackClient.chat.postMessage({
      channel: dmChannelId,
      blocks,
      text: fallbackText,
    });

    await digestDb.markDailyDigestSent(userId, teamId);
  } catch (err) {
    console.error(`[daily-digest] Failed for user ${userId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Daily morning scheduler
// ---------------------------------------------------------------------------

/**
 * Check if a user is due for their daily morning digest.
 * "Due" = local hour matches send_hour. Same approach as weekly — JS-side tz check.
 */
function isDailyDigestDue(row) {
  const tz = row.timezone || 'America/New_York';
  const now = new Date();

  let localHour;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hourStr = parts.find(p => p.type === 'hour')?.value;
    localHour = parseInt(hourStr, 10);
    if (localHour === 24) localHour = 0;
  } catch {
    localHour = now.getUTCHours();
  }

  return localHour === (row.send_hour ?? 9);
}

async function runDailyMorningCheck(slackClient) {
  try {
    const users = await digestDb.getUsersDueForDailyDigest();
    if (users.length === 0) return;

    const dueNow = users.filter(isDailyDigestDue);
    if (dueNow.length === 0) return;

    console.log(`[daily-digest] Sending to ${dueNow.length} users`);
    for (const user of dueNow) {
      await sendDailyDigestToUser(slackClient, user.user_id, user.team_id);
    }
  } catch (err) {
    console.error('[daily-digest] Check error:', err.message);
  }
}

function startDailyMorningScheduler(slackClient) {
  if (!slackClient) return;

  // Poll every 30 minutes — same cadence as weekly. Fires when local hour matches preference.
  const INTERVAL = 30 * 60 * 1000;
  setInterval(() => runDailyMorningCheck(slackClient), INTERVAL);

  // Run 25 seconds after startup to catch users whose hour just started
  setTimeout(() => runDailyMorningCheck(slackClient), 25000);

  console.log('[daily-digest] Daily morning scheduler started (30 min poll)');
}

module.exports = {
  init,
  startWeeklyDigestScheduler,
  startDailyMorningScheduler,
  runWeeklyDigestCheck,
  runDailyMorningCheck,
  sendDigestToUser,
  sendDailyDigestToUser,
  handleDigestComplete,
  handleDigestSnooze,
  handleDigestOptOut,
  handleDigestSettingsView,
  handleDigestSettingsEnable,
};
