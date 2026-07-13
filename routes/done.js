// /done command handler and pact completion flow.
// Owns: /done slash command, pact picker UI, fuzzy matching, multi-complete, AI inference (Pro).
// Does NOT own: pact creation, reminders, DM routing, tracker sync, or billing tier logic.
const pactDb = require('../db/pacts');
const { fuzzyMatchPacts } = require('../lib/fuzzy');
const aiDone = require('../lib/ai-done');
const { nextDueDate, recurrenceLabel } = require('../lib/recurrence');
const { randomUUID } = require('crypto');

// Injected via init() — getTeamTier requires billing module init; formatDate for recurrence msg
let _getTeamTier = null;
let _formatDate = null;

function init({ getTeamTier, formatDate }) {
  _getTeamTier = getTeamTier;
  _formatDate = formatDate;
}

/**
 * Resolve Slack display name for a user.
 */
async function getUserName(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    const profile = info.user.profile;
    return profile.display_name || info.user.real_name || info.user.name || userId;
  } catch {
    return userId;
  }
}

/**
 * Format a pact option for the picker, including pact number and due date.
 */
function formatPactOption(pact) {
  const dueSuffix = pact.due_date
    ? ` (due ${new Date(pact.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
    : '';
  const label = `#${pact.id}: ${pact.description.substring(0, 55)}${dueSuffix}`;
  return {
    text: { type: 'plain_text', text: label.substring(0, 75) },
    description: pact.counterparty_slack_id
      ? { type: 'plain_text', text: `with <@${pact.counterparty_slack_id}>`.substring(0, 75) }
      : undefined,
    value: String(pact.id)
  };
}

/**
 * Build multi-select blocks with checkboxes and a "Complete All" button.
 */
function buildMultiCompleteBlocks(pacts) {
  const checkboxOptions = pacts.slice(0, 10).map(pact => {
    const dueSuffix = pact.due_date
      ? ` (due ${new Date(pact.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      : '';
    const label = `#${pact.id}: ${pact.description.substring(0, 55)}${dueSuffix}`;
    return {
      text: { type: 'mrkdwn', text: label.substring(0, 75) },
      value: String(pact.id)
    };
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':white_check_mark: *Which pacts did you complete?* Select one or more:'
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'checkboxes',
          action_id: 'multi_pact_complete_select',
          options: checkboxOptions
        }
      ]
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'multi_pact_complete_confirm',
          text: { type: 'plain_text', text: '✓ Complete Selected', emoji: true },
          style: 'primary',
          value: 'confirm'
        },
        {
          type: 'button',
          action_id: 'multi_pact_complete_all',
          text: { type: 'plain_text', text: '✓ Complete All', emoji: true },
          value: pacts.slice(0, 10).map(p => p.id).join(',')
        }
      ]
    }
  ];
}

/**
 * Complete a single pact, post celebration message, and auto-spawn next recurrence.
 * Handles errors, tracker sync, channel fallback, and recurring pact continuation.
 */
async function completePact(pactId, userId, channelId, client, respond = null, tracker = null) {
  // Use markPactCompletedReturning so we get recurrence_rule + recurrence_group_id
  const pact = await pactDb.markPactCompletedReturning(pactId, userId);

  if (!pact) {
    const errorMsg = await pactDb.getPactCompletionError(pactId, userId);
    if (respond) {
      await respond(errorMsg);
    } else {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text: errorMsg });
    }
    return false;
  }

  // Async tracker completion sync — non-blocking
  if (tracker) {
    (async () => {
      let completedByName;
      try { completedByName = await getUserName(client, userId); } catch {}
      tracker.completePactInTracker(require('../db/index'), pact.id, pact.team_id, {
        completedByName,
        completedAt: pact.completed_at || new Date()
      });
    })();
  }

  // ── Recurring pact: auto-spawn next instance ──────────────────────────────
  let recurringNextText = null;
  if (pact.recurrence_rule) {
    try {
      const rule = typeof pact.recurrence_rule === 'string'
        ? JSON.parse(pact.recurrence_rule)
        : pact.recurrence_rule;

      // Edge-case: overdue pact — next instance uses today, not missed date
      const baseDate = new Date(pact.due_date) < new Date() ? new Date() : new Date(pact.due_date);
      const nextDate = nextDueDate(rule, baseDate);

      // Preserve recurrence_group_id; generate one on the first-ever completion if absent
      const groupId = pact.recurrence_group_id || randomUUID();

      await pactDb.createRecurringInstance({
        teamId: pact.team_id,
        channelId: pact.channel_id,
        creatorSlackId: pact.creator_slack_id,
        creatorName: pact.creator_name,
        counterpartySlackId: pact.counterparty_slack_id,
        counterpartyName: pact.counterparty_name,
        description: pact.description,
        dueDate: nextDate,
        recurrenceRule: rule,
        recurrenceGroupId: groupId,
      });

      // Format the next due date for the completion message
      const dateLabel = _formatDate
        ? _formatDate(nextDate, null)
        : nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

      recurringNextText = `🔄 Next one due *${dateLabel}* _(${recurrenceLabel(rule)})_`;
      console.log(`[recurrence] Spawned next instance for pact #${pactId} due ${nextDate.toISOString()}`);
    } catch (recurErr) {
      // Non-fatal — completion already succeeded; just skip next-instance spawn
      console.error(`[recurrence] Failed to spawn next instance for pact #${pactId}:`, recurErr.message);
    }
  }

  const completionTextLines = [
    `:tada: *Pact #${pact.id} completed!*`,
    `_${pact.description}_`,
    '',
    `\uD83C\uDF89 Pact completed: ${pact.description}`,
    `Marked done by <@${userId}>`,
  ];
  if (recurringNextText) completionTextLines.push('', recurringNextText);

  const completionBlocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: completionTextLines.join('\n') }
    }
  ];
  const completionText = `🎉 Pact completed: ${pact.description}${recurringNextText ? ' — ' + recurringNextText.replace(/\*/g, '') : ''}`;

  if (respond) {
    await respond({ response_type: 'in_channel', blocks: completionBlocks, text: completionText });
  } else {
    try {
      await client.chat.postMessage({ channel: pact.channel_id, blocks: completionBlocks, text: completionText });
    } catch (postErr) {
      if (channelId && channelId !== pact.channel_id) {
        try {
          await client.chat.postMessage({ channel: channelId, blocks: completionBlocks, text: completionText });
        } catch (fallbackErr) {
          console.error(`[completePact] Could not post completion for pact ${pactId} to either channel:`, fallbackErr.message);
        }
      } else {
        console.error(`[completePact] Could not post completion for pact ${pactId}:`, postErr.message);
      }
    }
  }
  return true;
}

/**
 * Handle /done slash command.
 * Supports: direct ID, fuzzy text matching, multi-select picker, AI inference (Pro).
 *
 * AI inference runs when: no arguments given + team is Pro + more than 1 active pact.
 * Falls back to standard picker if AI returns no confident matches.
 */
async function handleDoneCommand({ command, ack, respond, client }, tracker = null) {
  console.log(`[SLACK CMD] /done from user=${command.user_id} team=${command.team_id} channel=${command.channel_id}`);
  await ack();
  const { channel_id, user_id, team_id, text } = command;

  // Backfill counterparty if this user is the unknown counterparty
  try {
    const userName = await getUserName(client, user_id);
    await pactDb.backfillCounterparty(channel_id, user_id, userName);
  } catch (err) {
    console.error('Counterparty backfill error:', err.message);
  }

  try {
    // If they gave a specific pact ID, complete it directly
    const directId = text && text.trim().match(/^#?(\d+)$/);
    if (directId) {
      await completePact(parseInt(directId[1]), user_id, channel_id, client, respond, tracker);
      return;
    }

    // Get active pacts
    const pacts = await pactDb.getActivePactsForDone(channel_id, user_id);

    if (pacts.length === 0) {
      await respond(':white_check_mark: No active pacts in this conversation. Use `/pact [commitment] by [date]` to create one!');
      return;
    }

    // If user typed text (not a pact ID), try fuzzy matching
    if (text && text.trim().length > 0) {
      const matches = fuzzyMatchPacts(text.trim(), pacts);

      if (matches.length === 1 && matches[0].score >= 0.6) {
        // Confident single match — complete directly
        await completePact(matches[0].pact.id, user_id, channel_id, client, respond, tracker);
        return;
      }

      if (matches.length > 0 && matches[0].score >= 0.3) {
        // Ambiguous matches — show top results as picker
        const topMatches = matches.slice(0, 5).map(m => m.pact);
        const blocks = buildMultiCompleteBlocks(topMatches);
        await respond({
          blocks,
          text: 'Which pact did you complete?'
        });
        return;
      }

      // No fuzzy matches found — fall through to AI or normal picker
    }

    // If only one active pact, complete it directly (no AI needed)
    if (pacts.length === 1) {
      await completePact(pacts[0].id, user_id, channel_id, client, respond, tracker);
      return;
    }

    // AI inference path (no text input, multiple pacts)
    // WHY: When user types bare /done, infer from recent channel activity which pact they likely finished.
    if (!text || text.trim().length === 0) {
      const teamTier = _getTeamTier ? await _getTeamTier(team_id) : 'free';
      if (teamTier === 'pro') {
        try {
          const recentMessages = await aiDone.fetchRecentUserMessages(client, channel_id, user_id, 10);
          const rankings = await aiDone.rankPactsByContext(pacts, {
            channelId: channel_id,
            userId: user_id,
            recentMessages,
            today: new Date(),
          });

          if (rankings.length > 0) {
            const suggestion = aiDone.buildAISuggestionBlocks(rankings);
            if (suggestion) {
              await respond({ blocks: suggestion.blocks, text: suggestion.text });
              return;
            }
          }
        } catch (aiErr) {
          // AI inference failed — degrade gracefully to standard picker
          console.error('[ai-done] inference error, falling back:', aiErr.message);
        }
      }
    }

    // Standard fallback: multiple pacts — show multi-select picker with checkboxes
    const blocks = buildMultiCompleteBlocks(pacts);
    await respond({
      blocks,
      text: 'Which pacts did you complete?'
    });

  } catch (error) {
    console.error('Error in /done:', error);
    try {
      await respond(':x: Something went wrong. Please try again.');
    } catch (e) {
      console.error('Failed to send error response:', e.message);
    }
  }
}

/**
 * Handle AI-confirm button — user confirmed the AI's top suggestion.
 * action.value is the pact ID.
 */
async function handleAIDoneConfirm({ ack, body, client, action }, tracker = null) {
  await ack();
  const pactId = parseInt(action.value);
  const userId = body.user.id;
  const channelId = body.channel?.id || body.container?.channel_id;

  const resolvedChannel = channelId || await pactDb.getPactChannelId(pactId);
  if (resolvedChannel) {
    await completePact(pactId, userId, resolvedChannel, client, null, tracker);
  } else {
    try {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: ':x: Could not determine the channel — try `/done #<pact_id>` instead.',
      });
    } catch {}
  }
}

/**
 * Handle "show all pacts" button from the AI suggestion — fall back to multi-select picker.
 */
async function handleAIDoneShowAll({ ack, body, client, respond }) {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel?.id || body.container?.channel_id;

  try {
    const pacts = await pactDb.getActivePactsForDone(channelId || userId, userId);
    if (pacts.length === 0) {
      await respond(':white_check_mark: No active pacts to show!');
      return;
    }
    const blocks = buildMultiCompleteBlocks(pacts);
    await respond({ response_type: 'ephemeral', replace_original: true, blocks, text: 'Your active pacts:' });
  } catch (err) {
    console.error('[ai-done] show-all error:', err.message);
    try { await respond(':x: Something went wrong. Please try again.'); } catch {}
  }
}

/**
 * Handle the multi-complete confirm button (complete selected checkboxes).
 */
async function handleMultiCompleteConfirm({ ack, body, client, action }, tracker = null) {
  await ack();
  const userId = body.user.id;
  let channelId = body.channel?.id || body.container?.channel_id;

  // Extract selected pact IDs from the checkboxes state
  const state = body.state?.values || {};
  let selectedIds = [];

  // Walk through block state to find checkbox selections
  for (const blockId of Object.keys(state)) {
    const blockState = state[blockId];
    if (blockState.multi_pact_complete_select) {
      const opts = blockState.multi_pact_complete_select.selected_options || [];
      selectedIds = opts.map(o => parseInt(o.value));
    }
  }

  if (selectedIds.length === 0) {
    try {
      await client.chat.postEphemeral({
        channel: channelId || userId,
        user: userId,
        text: ':thinking_face: No pacts selected. Pick at least one checkbox and try again.'
      });
    } catch {}
    return;
  }

  // Complete each selected pact
  let completed = 0;
  for (const pactId of selectedIds) {
    const resolvedChannel = channelId || await pactDb.getPactChannelId(pactId);
    if (resolvedChannel) {
      const ok = await completePact(pactId, userId, resolvedChannel, client, null, tracker);
      if (ok) completed++;
    }
  }

  if (completed > 1) {
    try {
      await client.chat.postEphemeral({
        channel: channelId || userId,
        user: userId,
        text: `:fire: ${completed} pacts completed in one go! You're on a roll.`
      });
    } catch {}
  }
}

/**
 * Handle "Complete All" button — completes every pact from the picker.
 */
async function handleMultiCompleteAll({ ack, body, client, action }, tracker = null) {
  await ack();
  const userId = body.user.id;
  let channelId = body.channel?.id || body.container?.channel_id;
  const pactIds = (action.value || '').split(',').map(id => parseInt(id)).filter(Boolean);

  if (pactIds.length === 0) return;

  let completed = 0;
  for (const pactId of pactIds) {
    const resolvedChannel = channelId || await pactDb.getPactChannelId(pactId);
    if (resolvedChannel) {
      const ok = await completePact(pactId, userId, resolvedChannel, client, null, tracker);
      if (ok) completed++;
    }
  }

  if (completed > 0) {
    try {
      await client.chat.postEphemeral({
        channel: channelId || userId,
        user: userId,
        text: `:boom: All ${completed} pacts marked complete! Clean slate.`
      });
    } catch {}
  }
}

/**
 * Handle legacy single-select picker (backwards compat for in-flight messages).
 */
async function handleSelectPactComplete({ action, ack, body, client }, tracker = null) {
  await ack();
  const pactId = parseInt(action.selected_option.value);
  const userId = body.user.id;
  let channelId = body.channel?.id || body.container?.channel_id;

  if (!channelId) {
    channelId = await pactDb.getPactChannelId(pactId);
  }

  if (channelId) {
    await completePact(pactId, userId, channelId, client, null, tracker);
  } else {
    console.error(`[select_pact_complete] could not resolve channelId for pact ${pactId}, user ${userId}`);
    try {
      await client.chat.postEphemeral({
        channel: userId,
        user: userId,
        text: ':x: Something went wrong completing the pact — could not determine the conversation. Please try `/done` directly.'
      });
    } catch (e) {
      console.error('[select_pact_complete] failed to send fallback error message:', e.message);
    }
  }
}

/**
 * Handle DM "done" message completion (from bot DM).
 */
async function handleDMComplete(client, userId, channelId, text, tracker = null) {
  // Check if they specified a pact ID
  const idMatch = text.match(/#?(\d+)/);
  if (idMatch) {
    await completePact(parseInt(idMatch[1]), userId, channelId, client, null, tracker);
    return;
  }

  const pacts = await pactDb.getUserActivePacts(userId);

  if (pacts.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':white_check_mark: You have no active pacts to complete!'
    });
    return;
  }

  // Try fuzzy matching if text has more than just "done"
  const cleanText = text.replace(/^done\s*/i, '').trim();
  if (cleanText.length > 0) {
    const matches = fuzzyMatchPacts(cleanText, pacts);
    if (matches.length === 1 && matches[0].score >= 0.6) {
      await completePact(matches[0].pact.id, userId, channelId, client, null, tracker);
      return;
    }
    if (matches.length > 0 && matches[0].score >= 0.3) {
      const topMatches = matches.slice(0, 5).map(m => m.pact);
      const blocks = buildMultiCompleteBlocks(topMatches);
      await client.chat.postMessage({
        channel: channelId,
        blocks,
        text: 'Which pact did you complete?'
      });
      return;
    }
  }

  if (pacts.length === 1) {
    await completePact(pacts[0].id, userId, channelId, client, null, tracker);
    return;
  }

  // Multiple pacts — show multi-select picker
  const blocks = buildMultiCompleteBlocks(pacts);
  await client.chat.postMessage({
    channel: channelId,
    blocks,
    text: 'Which pacts did you complete?'
  });
}

module.exports = {
  init,
  handleDoneCommand,
  handleSelectPactComplete,
  handleMultiCompleteConfirm,
  handleMultiCompleteAll,
  handleDMComplete,
  handleAIDoneConfirm,
  handleAIDoneShowAll,
  completePact,
  getUserName,
};
