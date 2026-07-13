// lib/first-pact-dm.js
// Owns: first-pact celebration DM — trigger, Block Kit content, action handling.
// Does NOT own: pact creation (receives post-INSERT signal), welcome DM, activation DM.
//
// Triggered after pact creation when the user's total pact count transitions 0 → 1.
// Idempotent — uses activation_events table to record first_pact_celebrated event.

'use strict';

const { WebClient } = require('@slack/web-api');
const {
  isFirstPactCelebrated,
  recordFirstPactCelebrated,
} = require('../db/user-activation');

// Injected via init()
let slackClient = null;
let trackError = null;

// ---------------------------------------------------------------------------
// Block Kit
// ---------------------------------------------------------------------------

/** Build the first-pact celebration DM blocks */
function buildCelebrationBlocks({ userId, teamId, partnerName, inviteLink = null }) {
  const tweetText = encodeURIComponent(
    "Just made my first Pact in Slack — finally a way to make sure \"I'll get that to you Friday\" actually happens. @makepact"
  );
  const twitterUrl = `https://twitter.com/intent/tweet?text=${tweetText}`;

  const firstLine = partnerName
    ? `You just made your first Pact — both of you will get reminded, neither has to chase.`
    : `You just made your first Pact — you and your partner will both get reminded.`;

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '🎉 *Your first commitment is live!*' },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: firstLine },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What you can do next:*',
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '📊 *Daily digest* — every morning you get a summary of active commitments' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '🔥 *Streaks* — complete on time to build your streak' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *Mark it done* — use `/done` or the App Home tab when you finish' },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🐦 Share on Twitter', emoji: true },
          url: twitterUrl,
          action_id: 'first_pact_share_twitter',
          value: `twitter:first_pact`,
        },
        {
          type: 'button',
          action_id: 'first_pact_make_another',
          text: { type: 'plain_text', text: 'Make another pact', emoji: true },
          style: 'primary',
          value: JSON.stringify({ userId }),
        },
      ],
    },
  ];

  // Viral invite CTA — show invite link if available (user has generated one)
  if (inviteLink) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Know someone at another company?* Share your invite link — they install Pact and you two become cross-workspace pact partners.`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `👉 <${inviteLink}|${inviteLink}>` },
      }
    );
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '💡 Tip: `/pact @someone to do X by Friday` works in any channel or DM.',
    }],
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Send celebration DM
// ---------------------------------------------------------------------------

/**
 * Send the first-pact celebration DM to the creator, if they have exactly 1 pact
 * and haven't received this DM before.
 *
 * @param {Object} p
 * @param {string} p.botToken - Slack bot token for this workspace
 * @param {string} p.userId - Slack user ID of the pact creator
 * @param {string} p.teamId - Slack workspace ID
 * @param {string|null} p.partnerName - Display name of the counterparty (or null for solo pacts)
 * @returns {Promise<boolean>} true if DM was sent, false if skipped
 */
async function sendFirstPactCelebration({ botToken, userId, teamId, partnerName }) {
  const client = botToken ? new WebClient(botToken) : slackClient;
  if (!client) {
    console.error('[FIRST-PACT] No Slack client available');
    return false;
  }

  // Idempotency: only send once per user
  const alreadyCelebrated = await isFirstPactCelebrated(teamId, userId);
  if (alreadyCelebrated) {
    console.log(`[FIRST-PACT] Already celebrated for team=${teamId} user=${userId}, skipping`);
    return false;
  }

  // Generate invite link for the viral CTA
  let inviteLink = null;
  try {
    const { createInvite } = require('../db/invites');
    const invite = await createInvite({ inviterUserId: userId, inviterTeamId: teamId });
    inviteLink = invite.invite_link;
  } catch (invErr) {
    console.warn('[FIRST-PACT] Could not generate invite link:', invErr.message);
  }

  try {
    // Open DM channel with the creator
    const dmResult = await client.conversations.open({ users: userId });
    const dmChannel = dmResult.channel?.id;
    if (!dmChannel) {
      console.error(`[FIRST-PACT] Could not open DM with user=${userId}`);
      return false;
    }

    const blocks = buildCelebrationBlocks({ userId, teamId, partnerName, inviteLink });

    await client.chat.postMessage({
      channel: dmChannel,
      text: '🎉 Your first pact is live! See what you can do next.',
      blocks,
    });

    await recordFirstPactCelebrated(teamId, userId);
    console.log(`[FIRST-PACT] Celebration DM sent team=${teamId} user=${userId}`);
    return true;
  } catch (err) {
    console.error(`[FIRST-PACT] sendFirstPactCelebration failed user=${userId}: ${err.message}`);
    if (trackError) trackError(err.message, { tag: 'first-pact-dm' });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Action handlers — registered in registerSlackHandlers()
// ---------------------------------------------------------------------------

/** "Make another pact" — open pre-filled create pact modal */
async function handleFirstPactMakeAnother({ ack, body, client }) {
  await ack();

  // Lazy-import to avoid circular deps at module load time
  const { buildCreatePactModal } = require('./slack-handlers');

  const userId = body.user?.id;
  const teamId = body.team?.id || body.user?.team_id;

  if (!teamId || !userId) return;

  // Default due date = next Friday
  const nextFriday = (() => {
    const d = new Date();
    const day = d.getDay();
    const daysUntil = day <= 5 ? 5 - day : 7 - day + 5;
    const addDays = (day === 5 && d.getUTCHours() >= 17) ? 7 : daysUntil || 7;
    d.setDate(d.getDate() + addDays);
    d.setUTCHours(17, 0, 0, 0);
    return d;
  })();
  const dueDateStr = nextFriday.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const modalMeta = JSON.stringify({
    teamId,
    userId,
    channelId: body.channel?.id || null,
    cpId: null,
  });
  const modal = buildCreatePactModal({ pactData: modalMeta });
  const filledModal = {
    ...modal,
    blocks: modal.blocks.map((block) => {
      if (block.block_id === 'pact_due_date') {
        return {
          ...block,
          element: { ...block.element, initial_value: dueDateStr },
        };
      }
      return block;
    }),
  };

  try {
    await client.views.open({ trigger_id: body.trigger_id, view: filledModal });
  } catch (err) {
    console.error('[FIRST-PACT] Failed to open pact modal:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init({ client, trackError: _trackError }) {
  slackClient = client;
  trackError = _trackError;
}

module.exports = {
  init,
  sendFirstPactCelebration,
  handleFirstPactMakeAnother,
};
