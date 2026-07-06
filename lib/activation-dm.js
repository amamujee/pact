// lib/activation-dm.js
// Owns: 24h activation DM — send, action handling, cron logic.
// Does NOT own: pact creation (delegates to create_pact_modal flow), billing, general onboarding nudge.
//
// WHY a separate module from slack-handlers.js:
// slack-handlers.js is already very large. This is a self-contained lifecycle feature
// with its own DB layer, Block Kit, and action handlers — keeping it isolated makes it
// testable and deletable when the activation window passes.

'use strict';

const { WebClient } = require('@slack/web-api');
const {
  getEligibleActivationUsers,
  markActivationDmSent,
  markActivationDmClicked,
  markActivationPactCreated,
  recordActivationEvent,
  logActivationDelivery,
} = require('../db/user-activation');
const { buildCreatePactModal } = require('./slack-handlers');
const { getAppUrl } = require('./app-url');

// Injected via init()
let slackClient = null;
let getUserTimezone = null;
let trackError = null;

const APP_BASE_URL = process.env.APP_BASE_URL || getAppUrl();
const HOW_IT_WORKS_URL = `${APP_BASE_URL}/#how-it-works`;

function activationRedirectUrl({ userId, teamId }) {
  return `${APP_BASE_URL}/activate?ref=activation_dm&user_id=${encodeURIComponent(userId)}&team_id=${encodeURIComponent(teamId)}`;
}

// Next Friday (or current Friday if before 5pm today) — default due date for starter pact
function nextFriday() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 5=Fri
  const daysUntilFriday = day <= 5 ? 5 - day : 7 - day + 5;
  // If today is Friday but past 5pm UTC, push to next Friday
  const addDays = (day === 5 && d.getUTCHours() >= 17) ? 7 : daysUntilFriday || 7;
  d.setDate(d.getDate() + addDays);
  d.setUTCHours(17, 0, 0, 0); // 5pm UTC ~ EOD
  return d;
}

function formatDateShort(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Build the activation DM Block Kit blocks.
 *
 * Uses static_select populated with the user's IM partners.
 * Falls back to users_select element if fewer than 2 candidates.
 */
function buildActivationDmBlocks({ userId, teamId, teammates, dueDateLabel }) {
  const useStaticSelect = teammates.length >= 2;

  // Picker element — static list from IM history or open user picker
  const pickerElement = useStaticSelect
    ? {
        type: 'static_select',
        action_id: 'activation_pick_teammate',
        placeholder: { type: 'plain_text', text: 'Pick a teammate…', emoji: true },
        options: teammates.slice(0, 5).map((tm) => ({
          text: { type: 'plain_text', text: tm.name, emoji: true },
          value: tm.id,
        })),
      }
    : {
        type: 'users_select',
        action_id: 'activation_pick_teammate',
        placeholder: { type: 'plain_text', text: 'Choose a teammate…', emoji: true },
      };

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '🤝 *Pact works best with a partner.* Pick someone you\'d like to keep a promise with this week.',
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Who do you want to make a pact with?*' },
      accessory: pickerElement,
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Your first pact — already drafted for you:*`,
          `_"I'll send you a 1:1 agenda by ${dueDateLabel}"_`,
          `Click *🤝 Make this Pact* to open it (editable before you send).`,
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'activation_pact_create',
          text: { type: 'plain_text', text: '🤝 Make this Pact', emoji: true },
          style: 'primary',
          // No url: — using action_id so Slack fires block_actions → handleActivationPactCreate
          // which logs the click + opens the pact modal with pre-filled text + due date.
          value: JSON.stringify({ creatorId: userId, dueDateLabel }),
        },
        {
          type: 'button',
          action_id: 'activation_how_it_works',
          text: { type: 'plain_text', text: 'Show me how it works', emoji: true },
          url: HOW_IT_WORKS_URL,
          value: 'how_it_works',
        },
        {
          type: 'button',
          action_id: 'activation_dismiss',
          text: { type: 'plain_text', text: 'Not now', emoji: true },
          value: JSON.stringify({ creatorId: userId }),
        },
      ],
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '_You can always start a pact later: open a DM with a teammate and type `/pact`_',
      }],
    },
  ];
}

/**
 * Fetch the top-5 most-recent IM partners for a user.
 * Excludes bots, self, and deactivated users.
 * Falls back gracefully — returns [] on error so the caller can use users_select instead.
 */
async function getRecentImparters(client, userId) {
  try {
    // conversations.list with types=im returns all 1:1 DM channels
    // WHY cursor-paged call: large workspaces can have 1000+ IMs;
    // we only need the most recent, so we limit to one page of 50 and sort by created desc.
    const result = await client.conversations.list({
      types: 'im',
      limit: 50,
      exclude_archived: true,
    });

    if (!result.ok || !result.channels) return [];

    // Sort by most recent activity (last message timestamp)
    const sorted = (result.channels || [])
      .filter((ch) => ch.user && ch.user !== userId && !ch.is_ext_shared)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));

    // Resolve user display names, filter bots + deactivated
    const candidates = [];
    for (const ch of sorted) {
      if (candidates.length >= 5) break;
      try {
        const info = await client.users.info({ user: ch.user });
        const u = info.user;
        if (!u || u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
        const name = u.profile?.display_name || u.real_name || u.name || ch.user;
        candidates.push({ id: ch.user, name });
      } catch {
        // non-fatal — skip this user
      }
    }
    return candidates;
  } catch (err) {
    console.warn('[ACTIVATION] getRecentImPartners error:', err.message);
    return [];
  }
}

/**
 * Send the activation DM to a single user.
 * Returns true on success, false on failure.
 */
async function sendActivationDm({ botToken, userId, teamId }) {
  const client = botToken ? new WebClient(botToken) : slackClient;
  if (!client) {
    console.error('[ACTIVATION] No Slack client available');
    return false;
  }

  try {
    // Time-of-day check: only send 9am–6pm in user's Slack timezone
    let tz = 'America/New_York';
    if (getUserTimezone) {
      tz = await getUserTimezone(client, userId).catch(() => 'America/New_York');
    }

    const nowInTz = new Date().toLocaleString('en-US', { timeZone: tz, hour12: false, hour: 'numeric' });
    const hour = parseInt(nowInTz.split(':')[0], 10);
    // Before 9am or after 6pm — skip, cron will retry next hour
    if (hour < 9 || hour >= 18) {
      console.log(`[ACTIVATION] Skipping user=${userId} — outside business hours in tz=${tz} (hour=${hour})`);
      return false;
    }

    const teammates = await getRecentImparters(client, userId);
    const dueDate = nextFriday();
    const dueDateLabel = formatDateShort(dueDate);

    // Log "attempted" before the API call so we capture the event even if Slack times out
    await logActivationDelivery(teamId, userId, 'activation_dm_attempted', { tz, hour });

    const blocks = buildActivationDmBlocks({ userId, teamId, teammates, dueDateLabel });

    // Open DM channel first (conversations.open is required before posting to a user)
    const dmResult = await client.conversations.open({ users: userId });
    const dmChannel = dmResult.channel?.id;
    if (!dmChannel) {
      const err = new Error('conversations.open returned no channel');
      console.error(`[ACTIVATION] Could not open DM with user=${userId}: ${err.message}`);
      await logActivationDelivery(teamId, userId, 'activation_dm_failed', { ok: false, error: 'no_channel', channel: null });
      if (trackError) trackError(err.message, { tag: 'activation-dm' });
      return false;
    }

    // Post the Block Kit DM — capture full API response for delivery logging
    const postResult = await client.chat.postMessage({
      channel: dmChannel,
      text: '🤝 Pact works best with a partner — make your first commitment',
      blocks,
    });

    // Log delivery outcome: ok + ts on success, error code on failure
    if (postResult.ok) {
      await logActivationDelivery(teamId, userId, 'activation_dm_delivered', postResult);
    } else {
      await logActivationDelivery(teamId, userId, 'activation_dm_failed', postResult);
      console.error(`[ACTIVATION] postMessage failed user=${userId}: ok=false error=${postResult.error}`);
    }

    await markActivationDmSent(teamId, userId);
    await recordActivationEvent(teamId, userId, 'activation_dm_sent', { tz, hour, dm_channel: dmChannel, slack_ts: postResult.ts });
    console.log(`[ACTIVATION] DM sent user=${userId} team=${teamId} ts=${postResult.ts} ok=${postResult.ok}`);
    return postResult.ok;
  } catch (err) {
    console.error(`[ACTIVATION] sendActivationDm failed user=${userId}: ${err.message}`);
    await logActivationDelivery(teamId, userId, 'activation_dm_failed', { ok: false, error: err.message });
    if (trackError) trackError(err.message, { tag: 'activation-dm' });
    return false;
  }
}

/**
 * Hourly cron: find eligible users and send activation DMs.
 */
async function checkActivationDue() {
  try {
    const users = await getEligibleActivationUsers();
    if (users.length === 0) return;

    console.log(`[ACTIVATION] Checking ${users.length} eligible users`);
    for (const row of users) {
      await sendActivationDm({
        botToken: row.bot_token,
        userId: row.user_id,
        teamId: row.team_id,
      });
    }
  } catch (err) {
    console.error('[ACTIVATION] checkActivationDue error:', err.message);
    if (trackError) trackError(err.message, { tag: 'activation-cron' });
  }
}

// ---------------------------------------------------------------------------
// Action handlers — registered in registerSlackHandlers()
// ---------------------------------------------------------------------------

/**
 * "🤝 Make this Pact" button — opens the existing create_pact_modal pre-filled.
 * Requires a trigger_id from the action payload.
 *
 * WHY we open the existing modal rather than custom flow:
 * The modal already handles pact creation, recurrence, and counterparty logic.
 * Pre-filling description + due date via initial_value is all we need.
 * We pass selectedCounterpartyId in private_metadata so the modal handler
 * can use it when creating the pact.
 */
async function handleActivationPactCreate({ ack, body, client }) {
  await ack();

  const userId = body.user?.id;
  const teamId = body.team?.id || body.user?.team_id;

  // Record the click
  if (teamId && userId) {
    markActivationDmClicked(teamId, userId).catch(() => {});
    recordActivationEvent(teamId, userId, 'activation_dm_clicked').catch(() => {});
  }

  // Find if user selected a teammate from the static_select in the same message
  // Slack sends the state of the entire message when a button is clicked
  const stateValues = body.state?.values || {};
  let selectedTeammateId = null;
  for (const blockValues of Object.values(stateValues)) {
    const pickAction = blockValues['activation_pick_teammate'];
    if (pickAction?.selected_user) {
      selectedTeammateId = pickAction.selected_user;
      break;
    }
    if (pickAction?.selected_option?.value) {
      selectedTeammateId = pickAction.selected_option.value;
      break;
    }
  }

  // Compute next Friday for default due date
  const dueDate = nextFriday();
  // Format as a string parseable by chrono-node: "Friday May 16"
  const dueDateStr = dueDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // We can't pre-fill the DM channel_id here because the activation DM is in the bot DM,
  // not between the creator and their selected counterparty.
  // We pass the selectedCounterpartyId so the modal submit handler can use it.
  const modalMeta = JSON.stringify({
    teamId,
    userId,
    channelId: body.channel?.id || null,
    cpId: selectedTeammateId || null,
    fromActivation: true,
  });

  // Build a pre-filled version of the create_pact_modal
  const modal = buildCreatePactModal({ pactData: modalMeta });

  // Inject initial values into description + due date blocks
  const filledModal = {
    ...modal,
    blocks: modal.blocks.map((block) => {
      if (block.block_id === 'pact_description') {
        return {
          ...block,
          element: {
            ...block.element,
            initial_value: "I'll send you a 1:1 agenda",
          },
        };
      }
      if (block.block_id === 'pact_due_date') {
        return {
          ...block,
          element: {
            ...block.element,
            initial_value: dueDateStr,
          },
        };
      }
      return block;
    }),
  };

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: filledModal,
    });
  } catch (err) {
    console.error('[ACTIVATION] Failed to open pact modal:', err.message);
  }
}

/**
 * "Not now" button — marks activation DM as dismissed so we don't re-send.
 * We reuse markActivationDmSent (already set) — the row already has sent_at.
 * Nothing else to do; just ack and optionally update the message.
 */
async function handleActivationDismiss({ ack, body, client }) {
  await ack();

  const userId = body.user?.id;
  const teamId = body.team?.id || body.user?.team_id;
  if (!teamId || !userId) return;

  // The DM was already marked sent. "Not now" = no further DMs needed.
  // Record the dismiss event so we can track it in analytics.
  recordActivationEvent(teamId, userId, 'activation_dm_dismissed').catch(() => {});

  // Update the message to collapse it (replace blocks with a simple text)
  try {
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: '👍 No worries — open a DM with a teammate and type `/pact` when you\'re ready.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '👍 No worries — open a DM with a teammate and type `/pact` when you\'re ready.',
            },
          },
        ],
      });
    }
  } catch (err) {
    console.warn('[ACTIVATION] Could not update dismiss message:', err.message);
  }
}

/**
 * Ack-only: "Show me how it works" is a URL button — Slack fires the action but we just ack.
 */
async function handleActivationHowItWorks({ ack }) {
  await ack();
}

/**
 * Called from server.js after pact creation if the creator had an activation record.
 * Marks the pact as created from the activation DM flow.
 */
async function onActivationPactCreated(teamId, userId) {
  try {
    await markActivationPactCreated(teamId, userId);
    await recordActivationEvent(teamId, userId, 'activation_pact_created');
  } catch (err) {
    console.warn('[ACTIVATION] onActivationPactCreated error:', err.message);
  }
}

function init({ client, getUserTimezone: _getUserTimezone, trackError: _trackError }) {
  slackClient = client;
  getUserTimezone = _getUserTimezone;
  trackError = _trackError;
}

module.exports = {
  init,
  checkActivationDue,
  sendActivationDm,
  handleActivationPactCreate,
  handleActivationDismiss,
  handleActivationHowItWorks,
  onActivationPactCreated,
};
