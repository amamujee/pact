// lib/streak-milestones.js
// Owns: milestone detection cron, celebration DM builder, /pact share card generation.
// Does NOT own: pact completion logic, billing checks, Home Tab rendering, or HTML for /streak.

'use strict';

const {
  hasMilestoneBeenAwarded,
  recordMilestone,
  createShareCard,
  getLatestShareCardForUser,
  getUsersWithRecentCompletions,
} = require('../db/streak-milestones');
const { getPromiseStreak, getPersonalStats } = require('../db/pacts');
const { getAppUrl } = require('./app-url');

// Milestones we award, in ascending order.
const MILESTONES = [7, 30, 100];

// Injected via init()
let slackClient = null;
let getUserTimezone = null;
let appBaseUrl = null;

function init({ client, getUserTimezone: _getUserTimezone, baseUrl }) {
  slackClient = client;
  getUserTimezone = _getUserTimezone;
  appBaseUrl = baseUrl || getAppUrl();
}

// ---------------------------------------------------------------------------
// Share card URL builder
// ---------------------------------------------------------------------------

function shareCardUrl(token) {
  return `${appBaseUrl}/streak/${token}`;
}

// ---------------------------------------------------------------------------
// Social copy builders — used in DM buttons
// ---------------------------------------------------------------------------

function twitterShareUrl(cardUrl, milestoneDays) {
  const copy = `Just hit a ${milestoneDays}-day promise streak on @PactHQ 🤝 every commitment I made to a coworker, kept on time.`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(copy + ' ' + cardUrl)}`;
}

function linkedInShareUrl(cardUrl) {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(cardUrl)}`;
}

// ---------------------------------------------------------------------------
// DM builder — the celebration message sent on milestone
// ---------------------------------------------------------------------------

function milestoneEmoji(days) {
  if (days >= 100) return '🏆';
  if (days >= 30) return '🔥';
  return '⚡';
}

function milestoneHeadline(days) {
  if (days >= 100) return `${days} days of kept promises — that's legendary`;
  if (days >= 30) return `${days} days of kept promises — that's rare`;
  return `${days}-day promise streak — you're on a roll`;
}

/**
 * Build the Slack DM blocks for a milestone celebration message.
 * Includes share buttons for Twitter, LinkedIn, and copy link.
 */
function buildMilestoneDmBlocks({ milestoneDays, displayName, streak, pactsKept, onTimePct, cardUrl }) {
  const emoji = milestoneEmoji(milestoneDays);
  const headline = milestoneHeadline(milestoneDays);
  const firstName = displayName ? displayName.split(' ')[0] : null;
  const greeting = firstName ? `${firstName}, ` : '';
  const onTimePctDisplay = onTimePct > 0 ? `${onTimePct}% on time` : 'strong track record';

  const twitterUrl = twitterShareUrl(cardUrl, milestoneDays);
  const liUrl = linkedInShareUrl(cardUrl);

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${headline}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${greeting}you've kept your promises to colleagues for *${streak} consecutive days*.`,
          `That puts you in rare company — most people give up by day 3.`,
          `\n*${pactsKept} pacts* completed · *${onTimePctDisplay}* · *${streak}-day active streak*`,
        ].join(' '),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Share your achievement:*',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🐦 Share on Twitter', emoji: true },
          url: twitterUrl,
          action_id: 'streak_share_twitter',
          value: `twitter:${cardUrl}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '💼 Share on LinkedIn', emoji: true },
          url: liUrl,
          action_id: 'streak_share_linkedin',
          value: `linkedin:${cardUrl}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔗 Copy link', emoji: true },
          action_id: 'streak_copy_link',
          value: cardUrl,
        },
      ],
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_Card link: ${cardUrl}  ·  Valid for 90 days_`,
      }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Send celebration DM
// ---------------------------------------------------------------------------

async function sendMilestoneDm({ userId, teamId, milestoneDays }) {
  if (!slackClient) {
    console.error('[STREAK] sendMilestoneDm called before init()');
    return null;
  }

  try {
    // Fetch user info for display name and timezone
    let displayName = null;
    let tz = 'America/New_York';
    try {
      const info = await slackClient.users.info({ user: userId });
      const profile = info.user?.profile;
      displayName = profile?.display_name || info.user?.real_name || null;
      tz = info.user?.tz || 'America/New_York';
    } catch (err) {
      console.warn(`[STREAK] Could not fetch user info for ${userId}: ${err.message}`);
    }

    // Get live streak + stats
    const streak = await getPromiseStreak(userId, tz);
    const stats = await getPersonalStats(userId);
    const onTimePct = stats.totalCompleted > 0
      ? Math.round((stats.onTimeCount / stats.totalCompleted) * 100)
      : 0;

    // Create share card
    const token = await createShareCard({
      userId,
      teamId,
      milestoneDays,
      displayName,
      pactsKept: stats.totalCompleted,
      onTimePct,
    });
    const cardUrl = shareCardUrl(token);

    const blocks = buildMilestoneDmBlocks({
      milestoneDays,
      displayName,
      streak,
      pactsKept: stats.totalCompleted,
      onTimePct,
      cardUrl,
    });

    // Open DM with the user and post the celebration message
    const dmResult = await slackClient.conversations.open({ users: userId });
    const dmChannel = dmResult.channel?.id;
    if (!dmChannel) {
      console.error(`[STREAK] Could not open DM with user=${userId}`);
      return null;
    }

    await slackClient.chat.postMessage({
      channel: dmChannel,
      text: `🎉 You hit a ${milestoneDays}-day promise streak on Pact!`,
      blocks,
    });

    console.log(`[STREAK] Milestone DM sent user=${userId} days=${milestoneDays} token=${token}`);
    return token;
  } catch (err) {
    console.error(`[STREAK] sendMilestoneDm error user=${userId} days=${milestoneDays}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cron: detect and award milestones for active users
// ---------------------------------------------------------------------------

/**
 * Check all users with recent completions for milestone crossings.
 * Safe to run hourly — recordMilestone is idempotent (ON CONFLICT DO NOTHING).
 * WHY: We fetch streak per-user only when they have a recent completion so we
 * don't hammer the DB scanning every user on every tick.
 */
async function checkStreakMilestones() {
  if (!slackClient) return; // not yet initialized

  try {
    const users = await getUsersWithRecentCompletions();
    if (users.length === 0) return;

    console.log(`[STREAK] Checking ${users.length} users for milestone crossings`);

    for (const { user_id: userId, slack_team_id: teamId } of users) {
      try {
        // Get timezone — fall back gracefully to UTC
        let tz = 'UTC';
        if (getUserTimezone) {
          tz = await getUserTimezone(slackClient, userId).catch(() => 'UTC');
        }

        const streak = await getPromiseStreak(userId, tz);
        if (streak === 0) continue;

        // Check each milestone in ascending order
        for (const milestone of MILESTONES) {
          if (streak < milestone) continue; // not there yet

          const alreadyAwarded = await hasMilestoneBeenAwarded(userId, teamId, milestone);
          if (alreadyAwarded) continue; // already sent

          // Record first — if the DM fails we still won't double-send next tick
          const recorded = await recordMilestone(userId, teamId, milestone);
          if (!recorded) continue; // race condition — another process got there first

          // Send the celebration DM
          await sendMilestoneDm({ userId, teamId, milestoneDays: milestone });
        }
      } catch (userErr) {
        // Non-fatal — don't let one user's error kill the whole cron
        console.error(`[STREAK] Error processing user=${userId}: ${userErr.message}`);
      }
    }
  } catch (err) {
    console.error('[STREAK] checkStreakMilestones error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// /pact share — manual trigger for current streak card
// ---------------------------------------------------------------------------

/**
 * Generate (or retrieve existing) share card for the user's current streak.
 * Returns { token, cardUrl, streak, milestoneDays } or null if streak === 0.
 */
async function getOrCreateShareCard({ userId, teamId }) {
  if (!slackClient) return null;

  try {
    let tz = 'UTC';
    try {
      const info = await slackClient.users.info({ user: userId });
      tz = info.user?.tz || 'UTC';
    } catch (_) {}

    const streak = await getPromiseStreak(userId, tz);
    if (streak === 0) return null;

    // Pick the highest milestone achieved or use raw streak days
    let milestoneDays = streak;
    for (const m of MILESTONES) {
      if (streak >= m) milestoneDays = m;
    }

    // Reuse existing card if available
    const existing = await getLatestShareCardForUser(userId, teamId);
    if (existing) {
      return { token: existing.token, cardUrl: shareCardUrl(existing.token), streak, milestoneDays };
    }

    // Create a fresh card
    let displayName = null;
    let onTimePct = 0;
    let totalCompleted = 0;
    try {
      const info = await slackClient.users.info({ user: userId });
      const profile = info.user?.profile;
      displayName = profile?.display_name || info.user?.real_name || null;
    } catch (_) {}

    const stats = await getPersonalStats(userId);
    totalCompleted = stats.totalCompleted;
    onTimePct = stats.totalCompleted > 0
      ? Math.round((stats.onTimeCount / stats.totalCompleted) * 100)
      : 0;

    const token = await createShareCard({
      userId,
      teamId,
      milestoneDays,
      displayName,
      pactsKept: totalCompleted,
      onTimePct,
    });

    return { token, cardUrl: shareCardUrl(token), streak, milestoneDays };
  } catch (err) {
    console.error(`[STREAK] getOrCreateShareCard error user=${userId}: ${err.message}`);
    return null;
  }
}

/**
 * Build the /pact share response blocks (ephemeral).
 */
function buildShareCommandBlocks({ streak, milestoneDays, cardUrl }) {
  const emoji = milestoneEmoji(milestoneDays);
  const twitterUrl = twitterShareUrl(cardUrl, milestoneDays);
  const liUrl = linkedInShareUrl(cardUrl);

  return {
    text: `${emoji} Your ${streak}-day promise streak is shareable`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *Your ${streak}-day promise streak* — share it!`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🐦 Share on Twitter', emoji: true },
            url: twitterUrl,
            action_id: 'streak_share_twitter_cmd',
            value: `twitter:${cardUrl}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '💼 Share on LinkedIn', emoji: true },
            url: liUrl,
            action_id: 'streak_share_linkedin_cmd',
            value: `linkedin:${cardUrl}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔗 Copy link', emoji: true },
            action_id: 'streak_copy_link_cmd',
            value: cardUrl,
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_Card URL: ${cardUrl}_` }],
      },
    ],
  };
}

module.exports = {
  init,
  checkStreakMilestones,
  sendMilestoneDm,
  getOrCreateShareCard,
  buildShareCommandBlocks,
  shareCardUrl,
  MILESTONES,
};
