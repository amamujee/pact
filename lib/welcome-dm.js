// lib/welcome-dm.js
// Owns: immediate first-install welcome DM — trigger, content, action handling.
// Does NOT own: pact creation (delegates to create_pact_modal flow), activation DM (24h), billing.
//
// Triggered by app_home_opened for the installer user (team_join is covered by app_home_opened
// since the user opens the app after joining). Idempotent via welcome_dm_sent_at in installations.

'use strict';

const { WebClient } = require('@slack/web-api');
const {
  markWelcomeDmSent,
  isWelcomeDmSent,
  recordActivationEvent,
} = require('../db/user-activation');
const { getAppUrl } = require('./app-url');

// Injected via init()
let slackClient = null;
let getUserTimezone = null;
let trackError = null;

const APP_BASE_URL = process.env.APP_BASE_URL || getAppUrl();
const HOW_IT_WORKS_URL = `${APP_BASE_URL}/#how-it-works`;

// ---------------------------------------------------------------------------
// Block Kit
// ---------------------------------------------------------------------------

/** Build the welcome DM blocks */
function buildWelcomeDmBlocks({ userId }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '👋 *Welcome to Pact!*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Pact turns promises into tracked commitments so nothing falls through the cracks.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Get started:*',
      },
      accessory: {
        type: 'button',
        action_id: 'welcome_make_pact',
        text: { type: 'plain_text', text: 'Make your first pact', emoji: true },
        style: 'primary',
        value: JSON.stringify({ userId }),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_Learn how it works_',
      },
      accessory: {
        type: 'button',
        action_id: 'welcome_how_it_works',
        text: { type: 'plain_text', text: 'See how it works', emoji: true },
        url: HOW_IT_WORKS_URL,
        value: 'how_it_works',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_Skip for now_',
      },
      accessory: {
        type: 'button',
        action_id: 'welcome_dismiss',
        text: { type: 'plain_text', text: "I'll explore on my own", emoji: true },
        value: JSON.stringify({ userId }),
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '💡 Tip: Type `/pact @someone to do X by Friday` in any channel.',
      }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Send welcome DM
// ---------------------------------------------------------------------------

/**
 * Send the welcome DM to the installer user, if not already sent.
 * Idempotent — safe to call multiple times.
 */
async function sendWelcomeDm({ botToken, userId, teamId }) {
  const client = botToken ? new WebClient(botToken) : slackClient;
  if (!client) {
    console.error('[WELCOME] No Slack client available');
    return false;
  }

  try {
    // Idempotency check
    const alreadySent = await isWelcomeDmSent(teamId, userId);
    if (alreadySent) {
      console.log(`[WELCOME] Already sent for team=${teamId} user=${userId}, skipping`);
      return false;
    }

    const blocks = buildWelcomeDmBlocks({ userId });

    // Open DM channel
    const dmResult = await client.conversations.open({ users: userId });
    const dmChannel = dmResult.channel?.id;
    if (!dmChannel) {
      console.error(`[WELCOME] Could not open DM with user=${userId}`);
      return false;
    }

    await client.chat.postMessage({
      channel: dmChannel,
      text: '👋 Welcome to Pact! Get started in seconds.',
      blocks,
    });

    await markWelcomeDmSent(teamId, userId);
    await recordActivationEvent(teamId, userId, 'welcome_dm_sent');
    console.log(`[WELCOME] DM sent team=${teamId} user=${userId}`);
    return true;
  } catch (err) {
    console.error(`[WELCOME] sendWelcomeDm failed user=${userId}: ${err.message}`);
    if (trackError) trackError(err.message, { tag: 'welcome-dm' });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Action handlers — registered in registerSlackHandlers()
// ---------------------------------------------------------------------------

/** "Make your first pact" — open pre-filled create pact modal */
async function handleWelcomeMakePact({ ack, body, client }) {
  await ack();

  const userId = body.user?.id;
  const teamId = body.team?.id || body.user?.team_id;

  if (teamId && userId) {
    recordActivationEvent(teamId, userId, 'welcome_dm_pact_clicked').catch(() => {});
  }

  // Lazy-import to avoid circular deps at module load time
  const { buildCreatePactModal } = require('./slack-handlers');

  // Default pact pre-fills: no description (user fills), due date = next Friday
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
    fromWelcome: true,
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
    console.error('[WELCOME] Failed to open pact modal:', err.message);
  }
}

/** "See how it works" — URL button, just ack */
async function handleWelcomeHowItWorks({ ack }) {
  await ack();
}

/** "I'll explore on my own" — mark dismissed, collapse message */
async function handleWelcomeDismiss({ ack, body, client }) {
  await ack();

  const userId = body.user?.id;
  const teamId = body.team?.id || body.user?.team_id;
  if (teamId && userId) {
    recordActivationEvent(teamId, userId, 'welcome_dm_dismissed').catch(() => {});
  }

  try {
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: "No worries — explore Pact at your own pace! Open the App Home tab anytime to create your first pact.",
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'No worries — explore Pact at your own pace! Open the App Home tab anytime to create your first pact.',
          },
        }],
      });
    }
  } catch (err) {
    console.warn('[WELCOME] Could not update dismiss message:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init({ client, getUserTimezone: _getUserTimezone, trackError: _trackError }) {
  slackClient = client;
  getUserTimezone = _getUserTimezone;
  trackError = _trackError;
}

module.exports = {
  init,
  sendWelcomeDm,
  handleWelcomeMakePact,
  handleWelcomeHowItWorks,
  handleWelcomeDismiss,
};
