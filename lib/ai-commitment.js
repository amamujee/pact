// lib/ai-commitment.js
// Owns: AI-powered commitment detection in channel messages — detect commitment
//       patterns, rate-limit suggestions, and build the ephemeral suggest-a-pact prompt.
// Does NOT own: pact creation, Slack command routing, billing/tier checks, reminder logic.

'use strict';

const { chat } = require('./ai-client');

// ---------------------------------------------------------------------------
// Rate-limit helpers
// ---------------------------------------------------------------------------

const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 suggestion per user per hour

/**
 * Check whether we can send a suggestion to this user.
 * Reads commitment_last_suggested_at from installations and checks the per-user timestamp.
 *
 * @param {Object} pool - pg Pool
 * @param {string} teamId
 * @param {string} userId
 * @returns {Promise<boolean>} true if OK to suggest
 */
async function canSuggestToUser(pool, teamId, userId) {
  try {
    const result = await pool.query(
      'SELECT commitment_last_suggested_at FROM installations WHERE team_id = $1 LIMIT 1',
      [teamId]
    );
    const map = result.rows[0]?.commitment_last_suggested_at || {};
    const lastTs = map[userId];
    if (!lastTs) return true;
    return Date.now() - new Date(lastTs).getTime() >= RATE_LIMIT_MS;
  } catch {
    return true; // fail-open
  }
}

/**
 * Record that we just sent a suggestion to this user so the rate limiter kicks in.
 *
 * @param {Object} pool - pg Pool
 * @param {string} teamId
 * @param {string} userId
 */
async function recordSuggestion(pool, teamId, userId) {
  try {
    await pool.query(
      `UPDATE installations
       SET commitment_last_suggested_at =
         jsonb_set(
           COALESCE(commitment_last_suggested_at, '{}'::jsonb),
           $2::text[],
           $3::jsonb
         )
       WHERE team_id = $1`,
      [teamId, `{${userId}}`, JSON.stringify(new Date().toISOString())]
    );
  } catch {
    // Non-fatal — rate limit state just won't persist
  }
}

/**
 * Check whether the user has snoozed suggestions for this channel.
 *
 * @param {Object} pool
 * @param {string} teamId
 * @param {string} channelId
 * @returns {Promise<boolean>} true if snoozed (should skip)
 */
async function isChannelSnoozed(pool, teamId, channelId) {
  try {
    const result = await pool.query(
      'SELECT commitment_snoozed_channels FROM installations WHERE team_id = $1 LIMIT 1',
      [teamId]
    );
    const list = result.rows[0]?.commitment_snoozed_channels || [];
    return list.includes(channelId);
  } catch {
    return false;
  }
}

/**
 * Add channelId to the snoozed list for this team.
 *
 * @param {Object} pool
 * @param {string} teamId
 * @param {string} channelId
 */
async function snoozeChannel(pool, teamId, channelId) {
  try {
    await pool.query(
      `UPDATE installations
       SET commitment_snoozed_channels =
         (COALESCE(commitment_snoozed_channels, '[]'::jsonb) || $2::jsonb)
       WHERE team_id = $1
         AND NOT (COALESCE(commitment_snoozed_channels, '[]'::jsonb) @> $2::jsonb)`,
      [teamId, JSON.stringify(channelId)]
    );
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// AI detection
// ---------------------------------------------------------------------------

/**
 * Quick regex pre-filter: does the message contain any commitment keywords at all?
 * This runs BEFORE we call the AI, keeping costs low for unrelated messages.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeCommitment(text) {
  if (!text || text.length < 5) return false;

  const lower = text.toLowerCase();

  // Patterns like "I'll ...", "I will ...", "I'll have ...", "I promise ...",
  // "You'll have ...", "I'll get that done", "let me take care of"
  const patterns = [
    /\bi('ll| will| promise)\b/i,
    /\blet me (take care|handle|get)\b/i,
    /\b(you'll|you will) have\b/i,
    /\bby (friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow|tonight|eod|eow|cob|next week|\d+\s*(am|pm|[ap]m)|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/i,
    /\bget that done\b/i,
    /\bsend (you|it|that)\b/i,
    /\bfinish (it|that|this)\b/i,
    /\bdeliver\b/i,
    /\bship (it|that|this)\b/i,
    /\bwill have (it|that|this)\b/i,
  ];

  return patterns.some(p => p.test(lower));
}

/**
 * Use AI to analyze whether a message contains a specific actionable commitment,
 * and if so, extract the commitment details.
 *
 * Returns null if no confident commitment found.
 * Returns { description, possibleDueDate, promiserId, recipientId } if found.
 *
 * @param {string} messageText - the Slack message text
 * @param {Object} context - { userId, channelMembers: [{id, name}] }
 * @returns {Promise<null | { description: string, possibleDueDate: string|null, promiserId: string, recipientId: string|null }>}
 */
async function detectCommitment(messageText, context) {
  const memberList = (context.channelMembers || [])
    .map(m => `${m.id}: ${m.name}`)
    .join(', ');

  const systemPrompt = `You are a commitment detector for a Slack workspace. Your job is to identify when someone makes a specific, actionable commitment — not just general intentions, questions, or casual chat.

A commitment is HIGH confidence when:
- The speaker commits to a specific deliverable ("I'll send the proposal by Friday")
- It's directed at another person (not just thinking out loud)
- There's a clear "what" and ideally a "when"

LOW confidence or not a commitment:
- Questions or maybes ("should we do X?", "maybe I can help")
- Generic statements without specifics ("I'll try")
- Completed actions ("I just sent it")
- Reactions/feedback ("looks good!")
- Casual chat unrelated to work deliverables

Only respond HIGH if you are quite sure. Err on the side of NO to avoid false positives.`;

  const userPrompt = `Message: "${messageText.substring(0, 500)}"

Sender user ID: ${context.userId}
Channel members: ${memberList || '(not available)'}

Is this message a specific actionable commitment?

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "is_commitment": true|false,
  "confidence": "high|medium|low",
  "description": "<extracted commitment as a clear task statement, max 100 chars>",
  "possible_due_date": "<extracted date string if mentioned, else null>",
  "promiser_id": "<Slack user ID of the person making the commitment, or null>",
  "recipient_id": "<Slack user ID of who the commitment is made to, or null>"
}

Rules:
- Only set is_commitment=true for HIGH confidence matches
- description should be written as a clear task ("Send the proposal", "Review the design doc")
- promiser_id should be the sender's ID unless someone else is explicitly committing
- recipient_id is the person this is committed TO (not the sender)
- If you can't identify the recipient from context, set recipient_id to null`;

  try {
    const raw = await chat(userPrompt, { system: systemPrompt, maxTokens: 256 });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.is_commitment || parsed.confidence !== 'high') return null;
    if (!parsed.description || parsed.description.trim().length < 3) return null;

    // Normalize: fall back to sender's userId if promiser can't be determined
    const promiserId = parsed.promiser_id || context.userId;
    const recipientId = parsed.recipient_id && parsed.recipient_id !== promiserId
      ? parsed.recipient_id
      : null;

    return {
      description: parsed.description.substring(0, 200).trim(),
      possibleDueDate: parsed.possible_due_date || null,
      promiserId,
      recipientId,
    };
  } catch {
    // AI error or bad JSON — fail silently, no suggestion
    return null;
  }
}

// ---------------------------------------------------------------------------
// Block Kit builder
// ---------------------------------------------------------------------------

/**
 * Build the ephemeral "Sounds like a commitment — make it a pact?" Block Kit message.
 *
 * @param {Object} params
 * @param {string} params.description - extracted commitment description
 * @param {string|null} params.possibleDueDate - extracted due date string, if any
 * @param {string} params.promiserId - Slack user ID of the promiser
 * @param {string|null} params.recipientId - Slack user ID of the recipient
 * @param {string} params.channelId - channel where the message was posted
 * @param {string} params.messageTs - timestamp of the original message
 * @param {string} params.teamId - Slack team ID
 * @returns {{ blocks: Object[], text: string }}
 */
function buildSuggestionBlocks({ description, possibleDueDate, promiserId, recipientId, channelId, messageTs, teamId }) {
  const desc = description.substring(0, 80);
  const dueNote = possibleDueDate ? ` · Due: _${possibleDueDate}_` : '';
  const recipientNote = recipientId ? ` → <@${recipientId}>` : '';

  // Encode context for the action buttons so we can open the modal on confirm
  const actionPayload = JSON.stringify({
    description,
    possibleDueDate,
    promiserId,
    recipientId,
    channelId,
    messageTs,
    teamId,
  });

  return {
    text: `💬 Sounds like a commitment — make it a pact?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:handshake: *Sounds like a commitment — make it a pact?*\n\n_"${desc}"_${dueNote}${recipientNote}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'suggest_pact_confirm',
            text: { type: 'plain_text', text: '✅ Create Pact', emoji: true },
            style: 'primary',
            // truncate payload to stay under Slack's 2000-char value limit
            value: actionPayload.substring(0, 1900),
          },
          {
            type: 'button',
            action_id: 'suggest_pact_dismiss',
            text: { type: 'plain_text', text: 'Dismiss', emoji: true },
            value: JSON.stringify({ channelId, teamId }).substring(0, 1900),
          },
          {
            type: 'button',
            action_id: 'suggest_pact_snooze_channel',
            text: { type: 'plain_text', text: '🔕 Don\'t suggest in this channel', emoji: true },
            value: JSON.stringify({ channelId, teamId }).substring(0, 1900),
          },
        ],
      },
    ],
  };
}

module.exports = {
  looksLikeCommitment,
  detectCommitment,
  buildSuggestionBlocks,
  canSuggestToUser,
  recordSuggestion,
  isChannelSnoozed,
  snoozeChannel,
};
