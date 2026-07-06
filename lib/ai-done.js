// lib/ai-done.js
// Owns: AI-powered /done context inference — ranking active pacts by likelihood given recent Slack activity.
// Does NOT own: pact completion, Slack command routing, billing/tier checks, or message fetching logic.
'use strict';

const { chat } = require('./ai-client');

/**
 * Fetch recent messages from a Slack channel for a specific user.
 * Returns up to `limit` recent messages (text only, no bot messages).
 * @param {Object} client - Slack Web API client
 * @param {string} channelId - Slack channel ID
 * @param {string} userId - Slack user ID to filter messages by
 * @param {number} limit - max messages to retrieve
 * @returns {Promise<string[]>} array of message text strings
 */
async function fetchRecentUserMessages(client, channelId, userId, limit = 10) {
  try {
    const result = await client.conversations.history({
      channel: channelId,
      limit: 50,
    });
    const msgs = (result.messages || [])
      .filter(m => m.user === userId && m.text && !m.bot_id)
      .slice(0, limit)
      .map(m => m.text);
    return msgs;
  } catch {
    // History may be unavailable (no permission, archived channel, DM, etc.) — degrade gracefully
    return [];
  }
}

/**
 * Use AI to rank a user's active pacts by completion likelihood given context.
 *
 * Signals used:
 * - Recent messages in the channel
 * - Pact due dates (nearer = higher priority)
 * - Channel context (channelId matched to pact's channel_id)
 *
 * Returns an array of { pact, confidence, reason } sorted by confidence desc.
 * confidence: 'high' | 'medium' | 'low'
 *
 * @param {Object[]} pacts - active pact rows from db
 * @param {Object} context - { channelId, userId, recentMessages, today }
 * @returns {Promise<Array<{pact, confidence, reason}>>}
 */
async function rankPactsByContext(pacts, context) {
  if (pacts.length === 0) return [];

  const today = context.today || new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Build a compact representation of each pact for the prompt
  const pactList = pacts.map((p, i) => {
    const dueStr = p.due_date
      ? new Date(p.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'no due date';
    const inThisChannel = p.channel_id === context.channelId ? ' [same channel]' : '';
    const cp = p.counterparty_name || p.counterparty_slack_id || 'no counterparty';
    return `${i + 1}. ID:${p.id} | "${p.description}" | due:${dueStr} | with:${cp}${inThisChannel}`;
  }).join('\n');

  const recentMsgText = context.recentMessages && context.recentMessages.length > 0
    ? context.recentMessages.slice(0, 6).map(m => `- ${m.substring(0, 120)}`).join('\n')
    : '(no recent messages available)';

  const systemPrompt = `You are a helpful assistant that identifies which commitment a Slack user just completed based on context clues. Be concise, direct, and honest about uncertainty. Today is ${todayStr}.`;

  const userPrompt = `A user just typed /done with no arguments. They have these active pacts (commitments):

${pactList}

Their recent Slack messages in this channel:
${recentMsgText}

Based on the recent messages and pact context, which pact(s) are they most likely completing right now?

Respond ONLY with valid JSON (no markdown, no explanation outside the JSON):
{
  "rankings": [
    { "pact_id": <number>, "confidence": "high|medium|low", "reason": "<brief reason, max 15 words>" }
  ]
}

Rules:
- Include only pacts with at least "low" confidence
- List at most 3 pacts
- "high" means you're quite sure (recent messages strongly suggest it)
- "medium" means plausible (due date, channel match, or vague keyword)
- "low" means weak signal but worth showing
- If no signals match anything, return { "rankings": [] }`;

  try {
    const raw = await chat(userPrompt, { system: systemPrompt, maxTokens: 512 });

    // Parse JSON response from the model
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.rankings || !Array.isArray(parsed.rankings)) return [];

    // Map back to pact objects
    const pactMap = Object.fromEntries(pacts.map(p => [p.id, p]));
    return parsed.rankings
      .filter(r => pactMap[r.pact_id])
      .map(r => ({
        pact: pactMap[r.pact_id],
        confidence: r.confidence,
        reason: r.reason || '',
      }));
  } catch {
    // AI call failed or returned bad JSON — fall back silently
    return [];
  }
}

/**
 * Build the AI-suggestion Slack blocks for the /done response.
 * High confidence (single pact): confirmation prompt with Yes/No all-pacts buttons.
 * Medium/ambiguous: ranked list with checkboxes.
 *
 * @param {Array<{pact, confidence, reason}>} rankings
 * @returns {{ blocks: Object[], text: string } | null} null if no usable rankings
 */
function buildAISuggestionBlocks(rankings) {
  if (!rankings || rankings.length === 0) return null;

  const top = rankings[0];

  // High confidence single match → confirmation prompt
  if (top.confidence === 'high' && rankings.length === 1) {
    const dueStr = top.pact.due_date
      ? ` (due ${new Date(top.pact.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      : '';
    const desc = top.pact.description.substring(0, 60);

    return {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:sparkles: *Completing "${desc}${dueStr}"* — is that right?`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'ai_done_confirm',
              text: { type: 'plain_text', text: '✅ Yes, complete it', emoji: true },
              style: 'primary',
              value: String(top.pact.id),
            },
            {
              type: 'button',
              action_id: 'ai_done_show_all',
              text: { type: 'plain_text', text: 'No, show all pacts', emoji: true },
              value: 'show_all',
            },
          ],
        },
      ],
      text: `Completing "${desc}" — correct?`,
    };
  }

  // Multiple / medium confidence → show top 2-3 as checkboxes
  const topPacts = rankings.slice(0, 3);
  const checkboxOptions = topPacts.map(r => {
    const dueStr = r.pact.due_date
      ? ` (due ${new Date(r.pact.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
      : '';
    const label = `#${r.pact.id}: ${r.pact.description.substring(0, 50)}${dueStr}`;
    return {
      text: { type: 'mrkdwn', text: label.substring(0, 75) },
      value: String(r.pact.id),
    };
  });

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':sparkles: *Based on recent activity, which pact did you complete?*',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'checkboxes',
            action_id: 'multi_pact_complete_select',
            options: checkboxOptions,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'multi_pact_complete_confirm',
            text: { type: 'plain_text', text: '✓ Complete Selected', emoji: true },
            style: 'primary',
            value: 'confirm',
          },
          {
            type: 'button',
            action_id: 'ai_done_show_all',
            text: { type: 'plain_text', text: 'Show all pacts', emoji: true },
            value: 'show_all',
          },
        ],
      },
    ],
    text: 'Which pact did you complete?',
  };
}

module.exports = { fetchRecentUserMessages, rankPactsByContext, buildAISuggestionBlocks };
