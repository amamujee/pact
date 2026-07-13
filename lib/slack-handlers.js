// lib/slack-handlers.js
// Owns: all Slack command/action/event handlers, reminder/digest helpers, onboarding DM helpers
// Does NOT own: tracker OAuth routes, billing routes, metrics routes, page routes, OAuth callback registration

'use strict';

const { nextDueDate, recurrenceLabel } = require('./recurrence');
const { randomUUID } = require('crypto');
const { appUrl, getAppUrl } = require('./app-url');

// Dependencies injected via init()
let pool, tracker, doneRoutes, digestRoutes, pactsDb;
let formatDate, getUserTimezone, parseDueDate, getUserName, getStatusEmoji, getStatusLabel;
let BOT_DM, PEER_DM, getDMCounterparty, backfillCounterparty, resolveNullCounterparties;
let trackError;
let getTeamTier, planBadge, getMonthlyPactCount, PLAN_MONTHLY_LIMITS;

// AI commitment detection — lazy-required after init()
let aiCommitment = null;

// Activation DM — wired in registerSlackHandlers, used to mark pact creation
let activationDm = null;

// Bot user ID — set from start() after auth.test() via setBotUserId()
let botUserId = null;

// Home tab — lazy-required after init() so deps are injected first
let homeTab = null;

// Reschedule proposal handlers — lazy-required after init() so formatDate/getUserTimezone are injected
let rescheduleProposals = null;

// Bulk actions — lazy-required after init() so all deps are available
let bulkActions = null;

function init(deps) {
  pool = deps.pool;
  tracker = deps.tracker;
  doneRoutes = deps.doneRoutes;
  digestRoutes = deps.digestRoutes;
  pactsDb = deps.pactsDb;
  formatDate = deps.formatDate;
  getUserTimezone = deps.getUserTimezone;
  parseDueDate = deps.parseDueDate;
  getUserName = deps.getUserName;
  getStatusEmoji = deps.getStatusEmoji;
  getStatusLabel = deps.getStatusLabel;
  BOT_DM = deps.BOT_DM;
  PEER_DM = deps.PEER_DM;
  getDMCounterparty = deps.getDMCounterparty;
  backfillCounterparty = deps.backfillCounterparty;
  resolveNullCounterparties = deps.resolveNullCounterparties;
  trackError = deps.trackError;
  // Billing helpers (injected to avoid circular dep)
  const billing = require('./billing-routes');
  getTeamTier = billing.getTeamTier;
  planBadge = billing.planBadge;
  getMonthlyPactCount = billing.getMonthlyPactCount;
  PLAN_MONTHLY_LIMITS = billing.PLAN_MONTHLY_LIMITS;

  // Home tab — init with shared deps
  homeTab = require('./home-tab');
  homeTab.init({ pool, formatDate, getUserTimezone, getTeamTier });

  // Reschedule proposals — init after home-tab so we can pass the reference
  rescheduleProposals = require('./reschedule-proposals');
  rescheduleProposals.init({ formatDate, getUserTimezone, homeTab });

  // AI commitment detection — init after billing deps are available
  aiCommitment = require('./ai-commitment');

  // Bulk actions — init after homeTab so it can be passed as dep
  bulkActions = require('./bulk-actions');
  bulkActions.init({
    pool,
    formatDate,
    getUserTimezone,
    homeTab,
    pactDb: deps.pactsDb,
    tracker,
    getTeamTier,
  });
}

// Streak milestone module — lazy-required in registerSlackHandlers after Slack client is available
let streakMilestones = null;

// Welcome DM module — init and registered in registerSlackHandlers
let welcomeDm = null;

// First-pact celebration DM module — init and registered in registerSlackHandlers
let firstPactDm = null;

function setBotUserId(id) {
  botUserId = id;
}

/**
 * Check if the creator just hit their first pact (count = 1) and, if so,
 * send the celebration DM. Non-blocking — errors are caught and logged.
 * Idempotent via activation_events table.
 */
function triggerFirstPactCelebration({ creatorId, teamId, counterpartyName }) {
  if (!firstPactDm || !teamId) return;
  // Look up bot_token for this workspace to send the DM
  pool.query(
    `SELECT bot_token FROM installations WHERE team_id = $1 AND bot_token IS NOT NULL LIMIT 1`,
    [teamId]
  ).then(({ rows }) => {
    const botToken = rows[0]?.bot_token;
    if (!botToken) return;
    firstPactDm.sendFirstPactCelebration({
      botToken,
      userId: creatorId,
      teamId,
      partnerName: counterpartyName || null,
    }).catch(err => {
      console.error('[FIRST-PACT] trigger error:', err.message);
      if (trackError) trackError(err.message, { tag: 'first-pact-trigger' });
    });
  }).catch(err => console.error('[FIRST-PACT] bot_token lookup error:', err.message));
}

async function handleCreatePact({ command, ack, respond, client }) {
  console.log(`[SLACK CMD] /pact from user=${command.user_id} team=${command.team_id} channel=${command.channel_id} text="${(command.text || '').substring(0, 50)}"`);
  await ack();
  const { channel_id, user_id, text, team_id } = command;

  // Handle /pact settings subcommand (works from any channel)
  if (text && text.trim().toLowerCase() === 'settings') {
    await handleTrackerSettings({ respond, team_id, user_id });
    return;
  }

  // Handle /pact digest subcommand — show/manage weekly standup digest
  if (text && text.trim().toLowerCase() === 'digest') {
    await digestRoutes.handleDigestSettingsView(user_id, team_id, respond);
    return;
  }

  // Handle /pact upgrade subcommand — returns checkout link with team context
  if (text && text.trim().toLowerCase() === 'upgrade') {
    await handleUpgradeCommand({ respond, team_id, user_id });
    return;
  }

  // Handle /pact billing subcommand — opens Stripe billing portal for Pro, upgrade prompt for free
  if (text && text.trim().toLowerCase() === 'billing') {
    await handleBillingCommand({ respond, team_id, user_id });
    return;
  }

  // Handle /pact downgrade subcommand — alias for billing portal (legacy)
  if (text && text.trim().toLowerCase() === 'downgrade') {
    await handleDowngradeCommand({ respond, team_id, user_id });
    return;
  }

  // Handle /pact edit subcommand — update pact description
  if (text && /^edit\b/i.test(text.trim())) {
    await handleEditPact({ command, ack, respond, client });
    return;
  }

  // Handle /pact extend subcommand — extend deadline
  if (text && /^extend\b/i.test(text.trim())) {
    await handleExtendPact({ command, ack, respond, client });
    return;
  }

  // Handle /pact feedback subcommand (works from any channel)
  if (text && /^feedback\b/i.test(text.trim())) {
    await handleFeedbackCommand({ command, respond });
    return;
  }

  // Handle /pact help subcommand (works from any channel, ephemeral so only caller sees it)
  if (text && text.trim().toLowerCase() === 'help') {
    const helpTier = team_id ? await getTeamTier(team_id) : 'free';
    const badge = planBadge(helpTier);
    const planNote = helpTier === 'pro'
      ? `${badge} — Unlimited pacts + Linear, Notion, Asana sync`
      : `${badge} — Up to 100 pacts/month · _/pact upgrade_ to go Pro`;

    const { blocks, text: fallbackText } = buildOnboardingBlocks('help');
    const blocksWithTier = [
      ...blocks,
      { type: 'context', elements: [{ type: 'mrkdwn', text: planNote }] }
    ];

    await respond({ response_type: 'ephemeral', blocks: blocksWithTier, text: fallbackText });
    return;
  }

  // Handle /pact share subcommand — generate or retrieve share card for current streak
  if (text && text.trim().toLowerCase() === 'share') {
    if (streakMilestones) {
      const result = await streakMilestones.getOrCreateShareCard({ userId: user_id, teamId: team_id });
      if (!result) {
        await respond({ response_type: 'ephemeral', text: "You don't have an active streak yet — complete some pacts on consecutive days to build one! 🤝" });
      } else {
        const { text: fallback, blocks } = streakMilestones.buildShareCommandBlocks(result);
        await respond({ response_type: 'ephemeral', text: fallback, blocks });
      }
    } else {
      await respond({ response_type: 'ephemeral', text: 'Streak sharing not available yet — try again in a moment.' });
    }
    return;
  }

  // Handle /pact stats subcommand — personal accountability metrics
  if (text && text.trim().toLowerCase() === 'stats') {
    const tz = await getUserTimezone(user_id);
    const [stats, currentStreak, bestStreak] = await Promise.all([
      pactsDb.getUserPactStats(user_id),
      pactsDb.getPromiseStreak(user_id, tz),
      pactsDb.getBestStreak(user_id),
    ]);

    const { totalCreated, totalCompleted, totalActive, overdueCount, completionRate } = stats;
    const pct = completionRate;
    const pctColor = pct >= 80 ? 'good' : pct >= 50 ? 'warning' : 'danger';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📊 Your Pact Stats', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Pacts Created*\n' + totalCreated },
          { type: 'mrkdwn', text: '*Completed*\n' + totalCompleted + '  (`' + pct + '%` rate)' },
          { type: 'mrkdwn', text: '*Active*\n' + totalActive },
          { type: 'mrkdwn', text: '*Overdue*\n' + overdueCount },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Current Streak*\n:fire: ' + currentStreak + ' day' + (currentStreak !== 1 ? 's' : '') },
          { type: 'mrkdwn', text: '*Best Streak*\n:trophy: ' + bestStreak + ' day' + (bestStreak !== 1 ? 's' : '') },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '_Stats reflect pacts you created. Completion rate = completed / (completed + cancelled)._' },
        ],
      },
    ];

    await respond({
      response_type: 'ephemeral',
      blocks,
      text: `Your Pact Stats — ${totalCreated} created, ${totalCompleted} completed, ${currentStreak}-day streak`,
    });
    return;
  }

  // Handle /pact invite subcommand — show invite link + Pro incentive progress
  if (text && text.trim().toLowerCase() === 'invite') {
    await handleInviteCommand({ command, respond, client });
    return;
  }

  // 1. Reject non-DM channels (channels start with C, group DMs with G)
  if (!channel_id.startsWith('D')) {
    await respond('Pacts work in DMs for now. Open a DM with someone and try again.');
    return;
  }

  if (!text || !text.trim()) {
    // Open the create-pact modal (description + due date + repeats dropdown)
    // trigger_id is available on slash commands — 3-second window to open a modal
    try {
      const counterpartyId = await getDMCounterparty(client, channel_id, user_id, botUserId);
      const cpId = (counterpartyId && counterpartyId !== BOT_DM && counterpartyId !== PEER_DM)
        ? counterpartyId : null;
      const modalMeta = JSON.stringify({ channelId: channel_id, teamId: team_id, userId: user_id, cpId });
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildCreatePactModal({ pactData: modalMeta }),
      });
    } catch (modalErr) {
      // Fallback: show text usage if modal open fails (e.g. trigger_id expired)
      await respond([
        '*Usage:* `/pact [description] by [date]`',
        '',
        '*Examples:*',
        '`/pact Review the design doc by Friday`',
        '`/pact Send the invoice by Friday 5pm`',
        '`/pact Ship the landing page by next Monday`',
        '',
        '_Or type `/pact` with no text to open a creation form with repeat options._',
      ].join('\n'));
    }
    return;
  }

  try {
    // 2. Find the other person in this DM (filters out USLACKBOT + Pact bot)
    const counterpartyId = await getDMCounterparty(client, channel_id, user_id, botUserId);

    if (counterpartyId === BOT_DM) {
      await respond(":warning: Pacts need a human counterparty. Open a 1:1 DM with a teammate — not the Pact bot or yourself — and try again.");
      return;
    }

    if (!counterpartyId) {
      await respond(':warning: `/pact` only works in a DM between two people. Open a DM with someone and try again.');
      return;
    }

    // 3. Parse description, due date, and optional recurrence rule
    // Supports: "... --repeat daily|weekly|weekly:friday|biweekly|monthly"
    const { description: rawDescription, dueDate, recurrenceRule: parsedRule } = parseTextWithRecurrence(text.trim());
    const description = rawDescription;

    // 4. No date? Prompt.
    if (!dueDate) {
      await respond(
        `*When should "${description}" be done by?*\n\nRetry with a date: \`/pact ${description} by Friday 5pm\``
      );
      return;
    }

    // 5. Enforce monthly pact limits based on team's subscription tier
    const teamTier = await getTeamTier(team_id);
    const monthlyLimit = PLAN_MONTHLY_LIMITS[teamTier];
    if (monthlyLimit !== null) {
      const monthlyCount = await getMonthlyPactCount(team_id);
      if (monthlyCount >= monthlyLimit) {
        const upgradeUrl = 'https://makepact.co/#pricing';
        const upgradeMsg = `:warning: Your workspace has reached the *${monthlyLimit} active pacts/month* limit on the Free plan.\n\n*Upgrade to Pro ($10/mo flat)* for unlimited pacts + tracker sync (Linear, Notion, Asana).\n\nUpgrade at <${upgradeUrl}|makepact.co/#pricing> · Or type \`/pact upgrade\` to see checkout options.`;
        await respond(upgradeMsg);
        return;
      }
    }

    // 6. Create the pact immediately — no accept/decline, this is a direct commitment
    const [creatorName, creatorTz] = await Promise.all([
      getUserName(client, user_id),
      getUserTimezone(client, user_id),
    ]);
    const dueDateStr = formatDate(dueDate, creatorTz);

    // Resolve counterparty name if we have their ID (not PEER_DM)
    let cpId = counterpartyId === PEER_DM ? null : counterpartyId;
    let cpName = null;
    if (cpId) {
      cpName = await getUserName(client, cpId);
    }

    // If a recurrence rule was parsed, generate a group ID for the series
    const recurrenceGroupId = parsedRule ? randomUUID() : null;

    const result = await pool.query(
      `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                          counterparty_slack_id, counterparty_name, description, due_date, status,
                          recurrence_rule, recurrence_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10)
       RETURNING id`,
      [team_id, channel_id, user_id, creatorName, cpId, cpName, description, dueDate,
       parsedRule ? JSON.stringify(parsedRule) : null, recurrenceGroupId]
    );

    const pactId = result.rows[0].id;

    // Mark first_pact_created on the installation record if this creator is the installer
    pool.query(
      `UPDATE installations SET first_pact_created = TRUE
       WHERE team_id = $1 AND installer_user_id = $2 AND first_pact_created = FALSE`,
      [team_id, user_id]
    ).catch((err) => console.error('[onboarding] Failed to mark first_pact_created:', err.message));

    // First-pact celebration DM — fires if this is the creator's 0 → 1 transition
    triggerFirstPactCelebration({ creatorId: user_id, teamId: team_id, counterpartyName: cpName });

    // Mark the creator's workspace as "pact created within 7d" on any claimed invite —
    // this satisfies the quality threshold for the inviter's Pro grant counter.
    require('../db/invites').markInvitePactCreated(team_id).catch(() => {});

    // Async tracker sync — non-blocking, Pro tier teams only
    tracker.syncPactToTracker(pool, { id: pactId, description, due_date: dueDate, team_id, creator_name: creatorName, counterparty_name: cpName }, team_id, { creatorSlackId: user_id });

    // Refresh home tab for creator (and counterparty if known) — best-effort, non-blocking
    if (homeTab) {
      homeTab.publishHomeTab(client, user_id).catch(() => {});
      if (cpId) homeTab.publishHomeTab(client, cpId).catch(() => {});
    }

    // Build the commitment message — visible to both people in the DM
    const betweenText = cpId
      ? `<@${user_id}> & <@${cpId}>`
      : `<@${user_id}> & the other person in this DM`;
    const reminderText = cpId
      ? `Both <@${user_id}> and <@${cpId}> will be reminded`
      : `You'll both be reminded`;

    const recurLine = parsedRule
      ? `🔄 *Repeats:* ${recurrenceLabel(parsedRule)}`
      : null;

    const commitmentBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:handshake: *<@${user_id}> committed to:*\n\n*${description}*\nDue: *${dueDateStr}*${recurLine ? '\n' + recurLine : ''}`
        }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `${reminderText} \u2022 Type \`/done\` to mark complete` }
        ]
      }
    ];
    const commitmentText = `Pact #${pactId}: ${creatorName} committed to: ${description} — due ${dueDateStr}${parsedRule ? ' · Repeats: ' + recurrenceLabel(parsedRule) : ''}`;

    await respond({
      response_type: 'in_channel',
      blocks: commitmentBlocks,
      text: commitmentText,
    });

  } catch (error) {
    console.error('Error creating pact:', error);
    try {
      await respond(':x: Something went wrong creating the pact. Please try again.');
    } catch (e) {
      console.error('Failed to send error response:', e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Pact Edit / Extend Commands
// ---------------------------------------------------------------------------

async function handleEditPact({ command, ack, respond, client }) {
  console.log(`[SLACK CMD] /pact edit from user=${command.user_id} channel=${command.channel_id} text=${(command.text || '').substring(0, 80)}`);
  await ack();
  const { channel_id, user_id, text, team_id } = command;

  // Must be in DM
  if (!channel_id.startsWith('D')) {
    await respond(':warning: `/pact edit` only works in a DM conversation.');
    return;
  }

  // Parse: `edit [id] [new description]` or `edit [new description]`
  // First token after 'edit' — if it's a number, it's the pact ID
  const editText = (text || '').replace(/^edit\b/i, '').trim();
  if (!editText) {
    await respond('Usage: `/pact edit [pact #] [new description]` or `/pact edit [new description]`');
    return;
  }

  const tokens = editText.split(/\t\n\r\f /);
  const pactIdFromText = (() => {
    if (!tokens[0]) return null;
    const stripped = tokens[0].replace(/^#\/?/, '');
    const n = parseInt(stripped, 10);
    return (!isNaN(n) && String(n) === stripped && n > 0 && n < 100000) ? n : null;
  })();
  const newDescription = pactIdFromText !== null
    ? editText.substring(editText.indexOf(' ')).trim()
    : editText;

  if (!newDescription) {
    await respond('Usage: `/pact edit [pact #] [new description]` or `/pact edit [new description]`');
    return;
  }

  // Get creator's pacts — try current channel first, fall back to all user's pacts
  let result = await pool.query(
    `SELECT * FROM pacts
     WHERE channel_id = $1 AND creator_slack_id = $2 AND status = 'active'
     ORDER BY due_date ASC NULLS LAST`,
    [channel_id, user_id]
  );
  if (result.rows.length === 0) {
    result = await pool.query(
      `SELECT * FROM pacts
       WHERE creator_slack_id = $1 AND status = 'active'
       ORDER BY due_date ASC NULLS LAST LIMIT 15`,
      [user_id]
    );
  }

  if (result.rows.length === 0) {
    await respond(':x: You have no active pacts to edit.');
    return;
  }

  // If pact ID was given, find matching pact
  if (pactIdFromText !== null) {
    const pact = result.rows.find(p => p.id === pactIdFromText);
    if (!pact) {
      await respond(`:x: You don't have a pact #${pactIdFromText} in this conversation.`);
      return;
    }
    await applyEditPact(pact, newDescription, user_id, channel_id, client, respond);
    return;
  }

  // If only one pact, auto-select it
  if (result.rows.length === 1) {
    await applyEditPact(result.rows[0], newDescription, user_id, channel_id, client, respond);
    return;
  }

  // Multiple pacts — show picker
  const options = result.rows.slice(0, 10).map(pact => ({
    text: { type: 'plain_text', text: `#${pact.id}: ${pact.description.substring(0, 60)}` },
    value: JSON.stringify({ pactId: pact.id, description: newDescription })
  }));

  await respond({
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:pencil2: *Edit which pact?*\n\n_You said:_ ${newDescription}`
        },
        accessory: {
          type: 'static_select',
          action_id: 'select_pact_edit',
          placeholder: { type: 'plain_text', text: 'Pick a pact\u2026' },
          options
        }
      }
    ],
    text: 'Edit which pact?'
  });
}

async function applyEditPact(pact, newDescription, userId, channelId, client, respond) {
  const oldDescription = pact.description;
  const pactId = pact.id;

  // Update pact
  const updateResult = await pool.query(
    `UPDATE pacts SET description = $1, last_modified_at = NOW()
     WHERE id = $2 AND status = 'active' RETURNING *`,
    [newDescription, pactId]
  );

  if (updateResult.rows.length === 0) {
    if (respond) await respond(':x: Could not update the pact. It may have been completed.');
    return;
  }

  // Log the modification
  const userName = await getUserName(client, userId);
  await pool.query(
    `INSERT INTO pact_modifications (pact_id, modified_by, modified_by_name, modification_type, old_value, new_value)
     VALUES ($1, $2, $3, 'description', $4, $5)`,
    [pactId, userId, userName, oldDescription, newDescription]
  );

  // Notify in the DM
  const notificationText = `:pencil2: *<@${userId}> updated pact #${pactId}:*\n\n*Old:* ${oldDescription}\n*New:* ${newDescription}`;
  if (respond) {
    await respond({
      response_type: 'in_channel',
      text: `Pact #${pactId} edited: ${newDescription}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: notificationText } }]
    });
  }

  // Notify counterparty directly
  if (pact.counterparty_slack_id && pact.counterparty_slack_id !== userId) {
    try {
      const cpDM = await client.conversations.open({ users: pact.counterparty_slack_id });
      await client.chat.postMessage({
        channel: cpDM.channel.id,
        text: `Pact #${pactId} was updated by ${userName}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: notificationText } }]
      });
    } catch (e) {
      console.error('Failed to notify counterparty of edit:', e.message);
    }
  }
}

async function handleSelectPactEdit({ action, ack, body, client }) {
  await ack();
  const { value } = action.selected_option;
  const { pactId, description } = JSON.parse(value);
  const userId = body.user.id;
  const channelId = body.channel?.id || body.container?.channel_id;

  const result = await pool.query(
    `SELECT * FROM pacts WHERE id = $1 AND status = 'active' AND creator_slack_id = $2`,
    [pactId, userId]
  );

  if (result.rows.length === 0) {
    await client.chat.postMessage({ channel: channelId, text: ':x: You can only edit pacts you created.' });
    return;
  }

  await applyEditPact(result.rows[0], description, userId, channelId, client, null);
}

// ---------------------------------------------------------------------------
// Pact Extend
// ---------------------------------------------------------------------------

async function handleExtendPact({ command, ack, respond, client }) {
  console.log(`[SLACK CMD] /pact extend from user=${command.user_id} channel=${command.channel_id} text=${(command.text || '').substring(0, 80)}`);
  await ack();
  const { channel_id, user_id, text, team_id } = command;

  if (!channel_id.startsWith('D')) {
    await respond(':warning: `/pact extend` only works in a DM conversation.');
    return;
  }

  // Parse: `extend [id] to [new date]` or `extend to [new date]`
  const extendText = (text || '').replace(/^extend\b/i, '').trim();
  if (!extendText) {
    await respond('Usage: `/pact extend [pact #] to [new date]` or `/pact extend to [new date]`\n\nExample: `/pact extend to Friday`');
    return;
  }

  const toIdx = extendText.toLowerCase().lastIndexOf(' to ');
  let pactIdFromText = null;
  let dateText = extendText;

  if (toIdx > -1) {
    const beforeTo = extendText.substring(0, toIdx).trim();
    dateText = extendText.substring(toIdx + 4).trim();
    const stripped = beforeTo.replace(/^#\/?/, '').trim();
    const n = parseInt(stripped, 10);
    if (!isNaN(n) && String(n) === stripped && n > 0) pactIdFromText = n;
  }

  const { dueDate } = parseDueDate(dateText);
  if (!dueDate) {
    await respond(`:warning: I couldn't parse a date from *${dateText}*. Try: \n\n_\/pact extend to Friday_\n_\/pact extend 5 to next Monday_`);
    return;
  }

  const [, userTz] = await Promise.all([
    Promise.resolve(),
    getUserTimezone(client, user_id),
  ]);
  const dueDateStr = formatDate(dueDate, userTz);

  // Get creator's pacts — try current channel first, fall back to all user's pacts
  let result = await pool.query(
    `SELECT * FROM pacts
     WHERE channel_id = $1 AND creator_slack_id = $2 AND status = 'active'
     ORDER BY due_date ASC NULLS LAST`,
    [channel_id, user_id]
  );
  if (result.rows.length === 0) {
    result = await pool.query(
      `SELECT * FROM pacts
       WHERE creator_slack_id = $1 AND status = 'active'
       ORDER BY due_date ASC NULLS LAST LIMIT 15`,
      [user_id]
    );
  }

  if (result.rows.length === 0) {
    await respond(':x: You have no active pacts to extend.');
    return;
  }

  if (pactIdFromText !== null) {
    const pact = result.rows.find(p => p.id === pactIdFromText);
    if (!pact) {
      // Distinguish: pact already completed vs. genuinely not found
      let extendErrorMsg = `:x: You don't have an active pact #${pactIdFromText} in this conversation.`;
      try {
        const checkResult = await pool.query(
          `SELECT id, status FROM pacts WHERE id = $1`,
          [pactIdFromText]
        );
        if (checkResult.rows.length > 0 && checkResult.rows[0].status === 'completed') {
          extendErrorMsg = `:white_check_mark: Pact #${pactIdFromText} is already completed — nothing to extend.`;
        } else if (checkResult.rows.length > 0) {
          extendErrorMsg = `:x: Pact #${pactIdFromText} doesn't belong to this conversation.`;
        }
      } catch (e) {
        // Ignore, use default message
      }
      await respond(extendErrorMsg);
      return;
    }
    await applyExtendPact(pact, dueDate, dueDateStr, user_id, channel_id, client, respond, userTz);
    return;
  }

  if (result.rows.length === 1) {
    await applyExtendPact(result.rows[0], dueDate, dueDateStr, user_id, channel_id, client, respond, userTz);
    return;
  }

  const options = result.rows.slice(0, 10).map(pact => ({
    text: {
      type: 'plain_text',
      text: `#${pact.id}: ${pact.description.substring(0, 55)} (due ${formatDate(new Date(pact.due_date), userTz)})`
    },
    value: JSON.stringify({ pactId: pact.id, newDate: dueDate.toISOString() })
  }));

  await respond({
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:clock1: *Extend which pact to ${dueDateStr}?*` },
        accessory: {
          type: 'static_select',
          action_id: 'select_pact_extend',
          placeholder: { type: 'plain_text', text: 'Pick a pact\u2026' },
          options
        }
      }
    ],
    text: 'Extend which pact?'
  });
}

async function applyExtendPact(pact, newDueDate, dueDateStr, userId, channelId, client, respond, userTz) {
  const resolvedTz = userTz || 'America/New_York';
  const oldDueDate = pact.due_date;
  const pactId = pact.id;
  const oldEmoji = getStatusEmoji(oldDueDate);
  const newEmoji = getStatusEmoji(newDueDate);

  const updateResult = await pool.query(
    `UPDATE pacts SET due_date = $1, last_modified_at = NOW()
     WHERE id = $2 AND status = 'active' RETURNING *`,
    [newDueDate, pactId]
  );

  if (updateResult.rows.length === 0) {
    if (respond) await respond(':x: Could not update the pact. It may have been completed.');
    return;
  }

  // Log the modification
  const userName = await getUserName(client, userId);
  const oldDateStr = oldDueDate ? formatDate(new Date(oldDueDate), resolvedTz) : 'none';
  await pool.query(
    `INSERT INTO pact_modifications (pact_id, modified_by, modified_by_name, modification_type, old_value, new_value)
     VALUES ($1, $2, $3, 'due_date', $4, $5)`,
    [pactId, userId, userName, oldDateStr, dueDateStr]
  );

  const oldDateDisplay = oldDueDate ? formatDate(new Date(oldDueDate), resolvedTz) : 'no deadline';
  const notificationText = [
    `:clock1: *<@${userId}> extended pact #${pactId}*`,
    `_${pact.description}_`,
    '',
    `${oldEmoji} ~~${oldDateDisplay}~~ ${newEmoji} → *${dueDateStr}*`
  ].join('\n');

  if (respond) {
    await respond({
      response_type: 'in_channel',
      text: `Pact #${pactId} extended to ${dueDateStr}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: notificationText } }]
    });
  }

  // Notify counterparty directly
  if (pact.counterparty_slack_id && pact.counterparty_slack_id !== userId) {
    try {
      const cpDM = await client.conversations.open({ users: pact.counterparty_slack_id });
      await client.chat.postMessage({
        channel: cpDM.channel.id,
        text: `Pact #${pactId} deadline extended by ${userName}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: notificationText } }]
      });
    } catch (e) {
      console.error('Failed to notify counterparty of extend:', e.message);
    }
  }
}

async function handleSelectPactExtend({ action, ack, body, client }) {
  await ack();
  const { value } = action.selected_option;
  const { pactId, newDate } = JSON.parse(value);
  const userId = body.user.id;
  const channelId = body.channel?.id || body.container?.channel_id;
  const dueDate = new Date(newDate);

  const result = await pool.query(
    `SELECT * FROM pacts WHERE id = $1 AND status = 'active' AND creator_slack_id = $2`,
    [pactId, userId]
  );

  if (result.rows.length === 0) {
    await client.chat.postMessage({ channel: channelId, text: ':x: You can only extend pacts you created.' });
    return;
  }

  const userTzForExtend = await getUserTimezone(client, userId);
  await applyExtendPact(result.rows[0], dueDate, formatDate(dueDate, userTzForExtend), userId, channelId, client, null, userTzForExtend);
}

// ---------------------------------------------------------------------------
// Tracker Settings Command Handler
// ---------------------------------------------------------------------------

async function handleTrackerSettings({ respond, team_id, user_id }) {
  try {
    const isPro = await tracker.isProTeam(pool, team_id);

    if (!isPro) {
      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🔗 Tracker Sync — Pro Feature', emoji: true }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Automatically sync pacts to *Linear*, *Asana*, or *Notion* when they\'re created — and mark them done when completed.\n\n*Available on the Pro plan — $10/month flat.*'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Upgrade to Pro ↗', emoji: true },
                style: 'primary',
                url: 'https://makepact.co/#pricing',
                action_id: 'tracker_upgrade_pro'
              }
            ]
          }
        ],
        text: 'Tracker Sync is a Pro feature. Upgrade at makepact.co/#pricing'
      });
      return;
    }

    const connected = await tracker.getTrackerStatus(pool, team_id);
    const configured = tracker.getConfiguredProviders();
    const APP_BASE = getAppUrl();

    // Generate OAuth state tokens only for configured providers
    const linearState = configured.linear ? tracker.generateState(team_id, user_id, 'linear') : null;
    const asanaState  = configured.asana  ? tracker.generateState(team_id, user_id, 'asana')  : null;
    const notionState = configured.notion ? tracker.generateState(team_id, user_id, 'notion') : null;

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔗 Tracker Settings', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Connect a tracker and pacts will sync automatically when created or completed.'
        }
      },
      { type: 'divider' }
    ];

    // Helper to add a tracker row
    function trackerRow(name, provider, state) {
      const conn = connected[provider];
      if (conn) {
        // Connected — show status + disconnect button
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${name}* ✅ Connected${conn.projectName ? ` — _${conn.projectName}_` : ''}`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Disconnect', emoji: true },
            style: 'danger',
            value: `disconnect:${provider}`,
            action_id: `tracker_disconnect_${provider}`
          }
        });
      } else if (state) {
        // Not connected, but OAuth credentials are configured — show Connect button
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${name}*  _Not connected_`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: `Connect ${name} ↗`, emoji: true },
            style: 'primary',
            url: `${APP_BASE}/auth/${provider}/start?state=${state}`,
            action_id: `tracker_connect_${provider}`
          }
        });
      } else {
        // OAuth credentials not yet configured — show coming soon
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${name}*  _Coming soon_`
          }
        });
      }
    }

    trackerRow('Linear', 'linear', linearState);
    trackerRow('Asana', 'asana', asanaState);
    trackerRow('Notion', 'notion', notionState);

    await respond({
      response_type: 'ephemeral',
      blocks,
      text: 'Tracker Settings'
    });

  } catch (err) {
    console.error('[tracker settings] error:', err.message);
    await respond(':x: Something went wrong loading tracker settings. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Invite Command Handler (/pact invite)
// Shows user's invite link + Pro incentive progress.
// ---------------------------------------------------------------------------

async function handleInviteCommand({ command, respond, client }) {
  const { user_id, team_id } = command;

  try {
    const {
      createInvite,
      getTeamsJoinedCount,
      getSuccessfulInviteCount,
    } = require('../db/invites');

    // Get or create invite link for this user
    const invite = await createInvite({ inviterUserId: user_id, inviterTeamId: team_id });
    const link = invite.invite_link;

    // Progress toward the 2-workspace threshold for 30-day Pro
    const successfulCount = await getSuccessfulInviteCount(user_id, team_id);
    const remaining = Math.max(0, 2 - successfulCount);

    const progressBar = (successfulCount >= 2)
      ? '🟩🟩 Done!'
      : (successfulCount === 1)
        ? '🟩⬜ 1 / 2'
        : '⬜⬜ 0 / 2';

    const incentiveText = successfulCount >= 2
      ? ':trophy: *You\'ve earned 30 days of Pact Pro!* If it\'s not active yet, it will be shortly.'
      : `*Invite ${remaining} more workspace${remaining === 1 ? '' : 's'} → earn 30 days of Pro free.*\n\n_Both people need to create at least 1 pact within 7 days for it to count._`;

    const copyText = `invite 2 teammates' workspaces and get 30 days of Pact Pro on us. Share this link → ${link}`;
    const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`;
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(copyText)}`;

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':mega: *Invite 2 teams → get 30 days of Pact Pro free*\n\nShare your invite link below. When a teammate\'s workspace installs Pact and makes their first pact, it counts.',
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Your progress:* ${progressBar}\n${incentiveText}`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Your invite link:*\n<${link}|${link}>` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_Copy and paste this anywhere:_\n> ${copyText}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            url: twitterUrl,
            text: { type: 'plain_text', text: '🐦 Share on Twitter', emoji: true },
            value: 'twitter',
          },
          {
            type: 'button',
            url: linkedinUrl,
            text: { type: 'plain_text', text: '💼 Share on LinkedIn', emoji: true },
            value: 'linkedin',
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Your link never expires · Each workspace counts once · Pro activates automatically when you hit 2_' }],
      },
    ];

    await respond({ response_type: 'ephemeral', blocks, text: `Your Pact invite link: ${link} — invite 2 workspaces for 30 days Pro free.` });
  } catch (err) {
    console.error('[INVITE CMD] error:', err.message);
    await respond({ response_type: 'ephemeral', text: ':x: Could not generate your invite link. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// Upgrade Command Handler
// ---------------------------------------------------------------------------

async function handleUpgradeCommand({ respond, team_id, user_id }) {
  try {
    const currentTier = await getTeamTier(team_id);
    const monthlyCount = await getMonthlyPactCount(team_id);
    const limit = PLAN_MONTHLY_LIMITS[currentTier];

    const currentPlanLabel = currentTier.charAt(0).toUpperCase() + currentTier.slice(1);
    const usageStr = limit !== null
      ? `${monthlyCount}/${limit} pacts used this month`
      : `${monthlyCount} pacts this month (unlimited)`;

    if (currentTier === 'pro') {
      const APP_BASE = getAppUrl();
      const portalUrl = `${APP_BASE}/api/billing-portal?team_id=${encodeURIComponent(team_id)}&user_id=${encodeURIComponent(user_id)}`;
      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *You're on Pro ✦* — Unlimited pacts + Linear, Notion, Asana sync.\n${usageStr}`
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Manage Billing ↗', emoji: true },
              url: portalUrl,
              action_id: 'manage_billing_portal'
            }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'Upgrade, downgrade, update payment info, or download invoices — all in the billing portal. Questions: hello@makepact.co' }]
          }
        ],
        text: `You're on the Pro plan — unlimited pacts + tracker sync. (${usageStr})`,
      });
      return;
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⬆️ Upgrade to Pro', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Current plan:* _Free_ · ${usageStr}`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Pro Plan ✦ — $10/month flat*\nUnlimited pacts · Linear, Notion, Asana sync · No per-seat pricing`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Upgrade to Pro ↗', emoji: true },
          style: 'primary',
          url: appUrl(`/api/checkout?team_id=${encodeURIComponent(team_id)}&user_id=${encodeURIComponent(user_id)}`),
          action_id: 'upgrade_to_pro'
        }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'After payment, your workspace is activated automatically. You\'ll receive a DM confirmation. Questions: hello@makepact.co' }
        ]
      }
    ];

    await respond({
      response_type: 'ephemeral',
      blocks,
      text: 'Upgrade your Pact workspace to Pro — $10/month flat'
    });
  } catch (err) {
    console.error('[upgrade] error:', err.message);
    await respond(':x: Something went wrong. Try again or email hello@makepact.co');
  }
}

// ---------------------------------------------------------------------------
// Billing Command Handler — /pact billing
// Pro: Stripe Billing Portal to manage/cancel subscription
// Free: upgrade prompt
// ---------------------------------------------------------------------------
async function handleBillingCommand({ respond, team_id, user_id }) {
  try {
    const currentTier = await getTeamTier(team_id);
    const APP_BASE = getAppUrl();

    if (currentTier === 'pro') {
      const portalUrl = `${APP_BASE}/api/billing-portal?team_id=${encodeURIComponent(team_id)}&user_id=${encodeURIComponent(user_id)}`;
      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':credit_card: *Billing portal* — manage your Pro subscription, update payment, cancel, or download invoices.'
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Open Billing Portal ↗', emoji: true },
              url: portalUrl,
              action_id: 'manage_billing_portal_billing_cmd'
            }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'Cancellations take effect at the end of your current billing period. Questions: hello@makepact.co' }]
          }
        ],
        text: 'Open your Stripe billing portal to manage your Pro subscription.'
      });
    } else {
      const upgradeUrl = `${APP_BASE}/api/checkout?team_id=${encodeURIComponent(team_id)}&user_id=${encodeURIComponent(user_id)}`;
      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `_You're on the Free plan._ Upgrade to Pro ($10/month flat) for unlimited pacts, AI-powered \`/done\`, and tracker sync (Linear, Notion, Asana).`
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: '💳 Upgrade to Pro ↗', emoji: true },
              style: 'primary',
              url: upgradeUrl,
              action_id: 'upgrade_to_pro_billing_cmd'
            }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'Try `/pact upgrade` for the full upgrade flow. Questions: hello@makepact.co' }]
          }
        ],
        text: "You're on the free plan — try `/pact upgrade` to go Pro."
      });
    }
  } catch (err) {
    console.error('[billing-cmd] error:', err.message);
    await respond(':x: Something went wrong. Try again or email hello@makepact.co');
  }
}

async function handleDowngradeCommand({ respond, team_id, user_id }) {
  try {
    const currentTier = await getTeamTier(team_id);
    const APP_BASE = getAppUrl();
    const portalUrl = `${APP_BASE}/api/billing-portal?team_id=${encodeURIComponent(team_id)}&user_id=${encodeURIComponent(user_id)}`;

    if (currentTier !== 'pro') {
      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `_You're already on the Free plan._ No action needed.\n\nWant Pro? Unlimited pacts + tracker sync for $10/month.`
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Upgrade to Pro ↗', emoji: true },
              style: 'primary',
              url: `${APP_BASE}/api/checkout?team_id=${encodeURIComponent(team_id)}&user_id=${encodeURIComponent(user_id)}`,
              action_id: 'upgrade_to_pro'
            }
          }
        ],
        text: "You're already on the Free plan.",
      });
      return;
    }

    await respond({
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:credit_card: *Manage your subscription*\n\nHere's your billing portal — cancel, downgrade, update payment info, or download invoices anytime.`
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open Billing Portal ↗', emoji: true },
            url: portalUrl,
            action_id: 'manage_billing_portal_downgrade'
          }
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Your workspace stays on Pro until the end of the billing period. Questions: hello@makepact.co' }]
        }
      ],
      text: "Open your billing portal to manage your subscription.",
    });
  } catch (err) {
    console.error('[downgrade] error:', err.message);
    await respond(':x: Something went wrong. Try again or email hello@makepact.co');
  }
}

async function handleListPacts({ command, ack, respond, client }) {
  console.log(`[SLACK CMD] /pacts from user=${command.user_id} team=${command.team_id} channel=${command.channel_id}`);
  await ack();
  const { channel_id, user_id, team_id } = command;

  // Backfill counterparty if this user is the unknown counterparty
  backfillCounterparty(channel_id, user_id, client, pool);

  try {
    // First try channel-scoped query
    const [result, userTz] = await Promise.all([
      pool.query(
        `SELECT * FROM pacts
         WHERE channel_id = $1 AND status = 'active'
         ORDER BY due_date ASC NULLS LAST, created_at DESC`,
        [channel_id]
      ),
      getUserTimezone(client, user_id),
    ]);

    // If no pacts in this channel, fall back to all the user's active pacts
    // WHY: Users often run /pacts from the bot DM or a different channel than
    // where the pact was created. Without this fallback, overdue pacts (and all
    // other cross-channel pacts) silently disappear from the user's view.
    let pacts = result.rows;
    let isCrossChannel = false;
    if (pacts.length === 0) {
      const userResult = await pool.query(
        `SELECT * FROM pacts
         WHERE (creator_slack_id = $1 OR counterparty_slack_id = $1) AND status = 'active'
         ORDER BY due_date ASC NULLS LAST, created_at DESC
         LIMIT 15`,
        [user_id]
      );
      pacts = userResult.rows;
      isCrossChannel = pacts.length > 0;
    }

    if (pacts.length === 0) {
      await respond('No active pacts in this conversation. Use `/pact` to create one!');
      return;
    }

    // Resolve null counterparties before displaying
    await resolveNullCounterparties(pacts, user_id, client, pool, botUserId);

    const headerText = isCrossChannel
      ? `📋 *Your active pacts (${pacts.length}):*`
      : `📋 *Active pacts in this conversation (${pacts.length}):*`;

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerText }
      }
    ];

    for (const pact of pacts) {
      const emoji = getStatusEmoji(pact.due_date);
      const dueStr = pact.due_date ? formatDate(new Date(pact.due_date), userTz) : 'No due date';
      const label = getStatusLabel(pact.due_date);
      const suffix = label ? ` _(${label})_` : '';
      // 🔄 badge for recurring pacts
      const recurBadge = pact.recurrence_rule ? ' 🔄' : '';

      const personStr = pact.counterparty_slack_id
        ? `<@${pact.creator_slack_id}> · <@${pact.counterparty_slack_id}>`
        : `<@${pact.creator_slack_id}> · a teammate`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji}  *"${pact.description}"*${recurBadge}\n      Due: ${dueStr} · ${personStr}${suffix}`
        }
      });
    }

    const listTier = await getTeamTier(team_id);
    const listBadge = planBadge(listTier);
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Type \`/done\` to mark a pact complete · \`/done 5\` to complete a specific pact  ·  ${listBadge}` }
      ]
    });

    await respond({
      blocks,
      text: `${pacts.length} active pacts`
    });

  } catch (error) {
    console.error('Error listing pacts:', error);
    try {
      await respond(':x: Something went wrong loading pacts. Please try again.');
    } catch (e) {
      console.error('Failed to send error response:', e.message);
    }
  }
}

async function handleDoneCommand({ command, ack, respond, client }) {
  console.log(`[SLACK CMD] /done from user=${command.user_id} team=${command.team_id} channel=${command.channel_id}`);
  await ack();
  const { channel_id, user_id, text } = command;

  // Backfill counterparty if this user is the unknown counterparty
  backfillCounterparty(channel_id, user_id, client, pool);

  try {
    // If they gave a specific pact ID, complete it directly
    const directId = text && text.trim().match(/^#?(\d+)$/);
    if (directId) {
      await completePact(parseInt(directId[1]), user_id, channel_id, client, respond);
      return;
    }

    // Try channel-scoped query first
    let result = await pool.query(
      `SELECT * FROM pacts
       WHERE channel_id = $1 AND status = 'active'
       ORDER BY due_date ASC NULLS LAST`,
      [channel_id]
    );

    // Fall back to all user's active pacts if none in this channel
    // WHY: Users run /done from the bot DM or a different channel than where
    // the pact was created. Without this, overdue pacts can't be completed.
    if (result.rows.length === 0) {
      result = await pool.query(
        `SELECT * FROM pacts
         WHERE (creator_slack_id = $1 OR counterparty_slack_id = $1) AND status = 'active'
         ORDER BY due_date ASC NULLS LAST
         LIMIT 15`,
        [user_id]
      );
    }

    if (result.rows.length === 0) {
      await respond(':white_check_mark: No active pacts in this conversation. Use `/pact [commitment] by [date]` to create one!');
      return;
    }

    // If only one active pact, complete it directly
    if (result.rows.length === 1) {
      await completePact(result.rows[0].id, user_id, channel_id, client, respond);
      return;
    }

    // Multiple pacts — show a picker
    const options = result.rows.map(pact => ({
      text: {
        type: 'plain_text',
        text: `#${pact.id}: ${pact.description.substring(0, 65)}`
      },
      value: String(pact.id)
    }));

    await respond({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':white_check_mark: *Which pact did you complete?*'
          },
          accessory: {
            type: 'static_select',
            action_id: 'select_pact_complete',
            placeholder: { type: 'plain_text', text: 'Pick a pact\u2026' },
            options
          }
        }
      ],
      text: 'Which pact did you complete?'
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

async function handleSelectPactComplete({ action, ack, body, client }) {
  await ack();
  const pactId = parseInt(action.selected_option.value);
  const userId = body.user.id;
  let channelId = body.channel?.id || body.container?.channel_id;

  // If channelId is missing from the action payload, fall back to the pact's own channel_id
  if (!channelId) {
    try {
      const pactRow = await pool.query('SELECT channel_id FROM pacts WHERE id = $1', [pactId]);
      if (pactRow.rows.length > 0) {
        channelId = pactRow.rows[0].channel_id;
      }
    } catch (e) {
      console.error('[select_pact_complete] channel lookup failed:', e.message);
    }
  }

  if (channelId) {
    await completePact(pactId, userId, channelId, client);
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

async function completePact(pactId, userId, channelId, client, respond = null) {
  // Use user-based authorization: the user must be the creator or counterparty.
  // WHY: Channel-based auth broke cross-channel completion — users couldn't
  // complete pacts from the bot DM or a different channel than where the pact
  // was created, causing the "overdue pacts can't be completed" bug.
  const result = await pool.query(
    `UPDATE pacts
     SET status = 'completed', completed_at = NOW(), completed_by = $1
     WHERE id = $2
       AND (creator_slack_id = $1 OR counterparty_slack_id = $1)
       AND status = 'active'
     RETURNING *`,
    [userId, pactId]
  );

  if (result.rows.length === 0) {
    // Distinguish: pact exists but already completed vs. not found / not authorized
    let errorMsg = `:x: Pact #${pactId} not found or you don't have permission to complete it.`;
    try {
      const checkResult = await pool.query(
        `SELECT id, status, creator_slack_id, counterparty_slack_id FROM pacts WHERE id = $1`,
        [pactId]
      );
      if (checkResult.rows.length > 0 && checkResult.rows[0].status === 'completed') {
        errorMsg = `:white_check_mark: Pact #${pactId} is already completed — nothing to do!`;
      } else if (checkResult.rows.length > 0) {
        const p = checkResult.rows[0];
        if (p.creator_slack_id !== userId && p.counterparty_slack_id !== userId) {
          errorMsg = `:x: Pact #${pactId} doesn't belong to you.`;
        }
      }
    } catch (e) {
      // Ignore lookup error, use default message
    }
    if (respond) {
      await respond(errorMsg);
    } else {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: errorMsg
      });
    }
    return;
  }

  const pact = result.rows[0];

  // Async tracker completion sync — non-blocking
  // Look up display name for the Linear comment; fall back silently if unavailable
  (async () => {
    let completedByName;
    try { completedByName = await getUserName(client, userId); } catch {}
    tracker.completePactInTracker(pool, pact.id, pact.team_id, {
      completedByName,
      completedAt: pact.completed_at || new Date()
    });
  })();

  // Refresh home tab for both parties — non-blocking, best-effort
  if (homeTab) {
    homeTab.publishHomeTab(client, userId).catch(() => {});
    if (pact.creator_slack_id && pact.creator_slack_id !== userId) {
      homeTab.publishHomeTab(client, pact.creator_slack_id).catch(() => {});
    }
    if (pact.counterparty_slack_id && pact.counterparty_slack_id !== userId) {
      homeTab.publishHomeTab(client, pact.counterparty_slack_id).catch(() => {});
    }
  }

  const completionBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `:tada: *Pact #${pact.id} completed!*`,
          `_${pact.description}_`,
          '',
          `\uD83C\uDF89 Pact completed: ${pact.description}`,
          `Marked done by <@${userId}>`
        ].join('\n')
      }
    }
  ];
  const completionText = `🎉 Pact completed: ${pact.description}`;

  // Use respond (via response_url) if available, otherwise chat.postMessage.
  // response_type: 'in_channel' means both parties in the DM see the message.
  if (respond) {
    await respond({ response_type: 'in_channel', blocks: completionBlocks, text: completionText });
  } else {
    // Try pact's original channel first; fall back to the caller's channel if
    // the bot can't post there (e.g. user-to-user DM → channel_not_found).
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
}

// ---------------------------------------------------------------------------
// Reminder System
// ---------------------------------------------------------------------------

let reminderSlackClient = null;

// Track consecutive channel_not_found failures per pact to avoid infinite retries
const channelNotFoundFailures = new Map(); // pactId -> consecutiveFailureCount

function startReminderChecker(slackClient) {
  if (!slackClient) return;
  reminderSlackClient = slackClient;

  // Check every 30 minutes
  setInterval(checkReminders, 30 * 60 * 1000);
  // First check 15 seconds after startup
  setTimeout(checkReminders, 15000);
  console.log('Reminder checker started (every 30 min)');
}

async function checkReminders(slackClient = reminderSlackClient) {
  if (!slackClient) return;
  reminderSlackClient = slackClient;

  try {
    // Pacts due within 24 hours that haven't been reminded in 12+ hours
    const result = await pool.query(`
      SELECT * FROM pacts
      WHERE status = 'active'
        AND due_date IS NOT NULL
        AND due_date <= (CURRENT_DATE + INTERVAL '1 day')
        AND (last_reminded_at IS NULL OR last_reminded_at < NOW() - INTERVAL '12 hours')
    `);

    if (result.rows.length === 0) return;

    console.log(`Sending reminders for ${result.rows.length} pact(s)`);

    for (const pact of result.rows) {
      try {
        const now = new Date();
        const due = new Date(pact.due_date);
        const isOverdue = due < now;
        const emoji = isOverdue ? ':red_circle:' : ':alarm_clock:';
        const label = isOverdue ? 'Overdue' : 'Due soon';

        const [reminderTier, creatorTz] = await Promise.all([
          pact.team_id ? getTeamTier(pact.team_id) : Promise.resolve('free'),
          getUserTimezone(slackClient, pact.creator_slack_id),
        ]);
        const reminderBadge = planBadge(reminderTier);
        const reminderResult = await slackClient.chat.postMessage({
          token: process.env.SLACK_BOT_TOKEN,
          channel: pact.channel_id,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `${emoji} *${label}: Pact #${pact.id}*`,
                  `_${pact.description}_`,
                  `Due: *${formatDate(due, creatorTz)}*`,
                  '',
                  `${pact.counterparty_slack_id ? `<@${pact.creator_slack_id}> & <@${pact.counterparty_slack_id}>` : `<@${pact.creator_slack_id}>`} \u2014 reply \`done\` or tap the button below`
                ].join('\n')
              }
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'complete_from_reminder',
                  text: { type: 'plain_text', text: '\u2705 Mark Complete', emoji: true },
                  style: 'primary',
                  value: String(pact.id)
                },
                {
                  type: 'button',
                  action_id: 'snooze_tomorrow',
                  text: { type: 'plain_text', text: '⏭ Tomorrow', emoji: true },
                  value: String(pact.id)
                },
                {
                  type: 'button',
                  action_id: 'snooze_3days',
                  text: { type: 'plain_text', text: '⏩ +3 Days', emoji: true },
                  value: String(pact.id)
                },
                {
                  type: 'button',
                  action_id: 'snooze_pick_date',
                  text: { type: 'plain_text', text: '📅 Pick a Date', emoji: true },
                  value: String(pact.id)
                }
              ]
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: reminderBadge }]
            }
          ],
          text: `${label}: Pact #${pact.id} - ${pact.description}`
        });

        await pool.query(
          'UPDATE pacts SET last_reminded_at = NOW() WHERE id = $1',
          [pact.id]
        );

        // Store reminder thread ts so replies can resolve back to this pact
        if (reminderResult.ok && reminderResult.ts) {
          const { updateReminderTs } = require('../db/pacts');
          await updateReminderTs(pact.id, pact.channel_id, reminderResult.ts).catch(e =>
            console.error(`[reminder] Failed to store reminder_ts for pact ${pact.id}:`, e.message)
          );
        }

        // Reset consecutive failure count on success
        channelNotFoundFailures.delete(pact.id);
      } catch (err) {
        if (err.code === 'channel_not_found' || err.message?.includes('channel_not_found')) {
          const failures = (channelNotFoundFailures.get(pact.id) || 0) + 1;
          channelNotFoundFailures.set(pact.id, failures);
          console.warn(`Reminder skipped for pact ${pact.id} (channel_not_found, attempt ${failures}): ${err.message}`);
          if (failures >= 3) {
            // After 3 consecutive failures, mark last_reminded_at so the pact won't be re-queried
            await pool.query(
              'UPDATE pacts SET last_reminded_at = NOW() WHERE id = $1',
              [pact.id]
            );
            console.warn(`Pact ${pact.id} reminder deactivated after 3 consecutive channel_not_found errors`);
          }
        } else {
          console.error(`Reminder failed for pact ${pact.id}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error('Reminder check error:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Daily Digest
// ---------------------------------------------------------------------------

// Returns milliseconds until the next 9:00 AM Eastern Time.
// Uses a fixed UTC-5 offset (close enough; DST shift is only ±1h).
function msUntilNext9amET() {
  const ET_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC-5
  const nowET = new Date(Date.now() - ET_OFFSET_MS);
  const next9am = new Date(nowET);
  next9am.setHours(9, 0, 0, 0);
  if (next9am <= nowET) next9am.setDate(next9am.getDate() + 1);
  return next9am.getTime() - nowET.getTime();
}

async function sendDailyDigest(slackClient) {
  console.log('[daily-digest] Running...');
  try {
    // Collect every unique slack user ID that appears in active pacts.
    // unnest(ARRAY[...]) expands both columns into one set.
    const result = await pool.query(`
      SELECT DISTINCT u AS user_id
      FROM pacts,
           unnest(ARRAY[creator_slack_id, counterparty_slack_id]) AS u
      WHERE status = 'active'
    `);

    const userIds = result.rows.map(r => r.user_id);
    console.log(`[daily-digest] ${userIds.length} user(s) with active pacts`);

    for (const userId of userIds) {
      try {
        const pacts = await getUserPacts(userId);
        if (pacts.length === 0) continue; // race condition guard

        // Open (or retrieve) the DM channel between bot and user
        const dmResult = await slackClient.conversations.open({ users: userId });
        const dmChannelId = dmResult.channel.id;

        const digestTeamId = pacts[0]?.team_id;
        const digestPlan = digestTeamId ? await getTeamTier(digestTeamId) : 'free';
        const blocks = await buildPactsBlocks(
          pacts,
          userId,
          `☀️ *Good morning! Here are your active pacts:*`,
          slackClient,
          digestPlan
        );

        await slackClient.chat.postMessage({
          channel: dmChannelId,
          blocks,
          text: `Good morning! You have ${pacts.length} active pact${pacts.length === 1 ? '' : 's'}.`
        });

        console.log(`[daily-digest] Sent to ${userId} (${pacts.length} pact(s))`);
      } catch (err) {
        console.error(`[daily-digest] Failed for user ${userId}:`, err.message);
      }
    }

    console.log('[daily-digest] Complete.');
  } catch (err) {
    console.error('[daily-digest] Error:', err.message);
  }
}

function startDailyDigest(slackClient) {
  if (!slackClient) return;

  function scheduleNext() {
    const delay = msUntilNext9amET();
    const mins  = Math.round(delay / 60000);
    console.log(`[daily-digest] Scheduled in ${mins} min (next 9am ET)`);

    setTimeout(async () => {
      try {
        await sendDailyDigest(slackClient);
      } catch (err) {
        console.error('[daily-digest] Run error:', err.message);
      }
      scheduleNext(); // reschedule for the next day
    }, delay);
  }

  scheduleNext();
  console.log('[daily-digest] Scheduler started (9am ET daily)');
}

// ---------------------------------------------------------------------------
// /pact feedback subcommand handler
// ---------------------------------------------------------------------------

async function handleFeedbackCommand({ command, respond }) {
  const { team_id, user_id, text } = command;
  const message = text.trim().replace(/^feedback\s*/i, '').trim();

  if (!message) {
    await respond(
      ':speech_balloon: To send feedback, use:\n`/pact feedback <your message>`\n\nExample: `/pact feedback I wish I could set recurring pacts`\n\nOr email us directly: *hello@makepact.co*'
    );
    return;
  }

  // Persist to DB
  try {
    await pool.query(
      'INSERT INTO feedback (team_id, user_slack_id, message) VALUES ($1, $2, $3)',
      [team_id, user_id, message]
    );
  } catch (err) {
    console.error('[feedback] DB insert error:', err.message);
  }

  // Email the support inbox when an email provider is configured.
  try {
    await require('./email-client').sendEmail({
      to: process.env.CONTACT_NOTIFY_EMAIL || 'hello@makepact.co',
      subject: `Pact feedback from workspace ${team_id}`,
      body: `Feedback from Slack user ${user_id} in workspace ${team_id}:\n\n${message}`,
      html: `<p><strong>From:</strong> Slack user <code>${user_id}</code> in workspace <code>${team_id}</code></p><p style="white-space:pre-wrap">${message}</p>`,
    });
  } catch (err) {
    console.error('[feedback] Email send error:', err.message);
  }

  await respond(':white_check_mark: Got it — a real human will see this. Thanks for taking the time.\n\nNeed faster help? Email *hello@makepact.co* directly.');
}

// ---------------------------------------------------------------------------
// Conversational DM Handler
// ---------------------------------------------------------------------------

function detectIntent(text) {
  const t = text.toLowerCase().trim();

  // Greetings
  if (/^(hi|hello|hey|sup|yo|howdy)[\s!?.]*$/.test(t)) return 'GREETING';

  // What is Pact
  if (/what\s+(is|are)\s+pact|tell\s+me\s+about|how\s+does\s+this\s+work|what\s+can\s+you\s+do/.test(t)) return 'WHAT_IS';

  // Help
  if (/^help[\s!?.]*$|^\/help|^\?$|^commands?$/.test(t)) return 'HELP';

  // List pacts
  if (/my\s+pacts?|show\s+pacts?|list\s+pacts?|active\s+pacts?|view\s+pacts?|what\s+pacts?|show\s+me\s+(my|the)|see\s+my/.test(t)) return 'LIST_PACTS';

  // Complete a pact
  if (/^(done|complete|finished|mark\s+(it\s+)?done|mark\s+(it\s+)?complete|i'?m\s+done|i\s+finished|it'?s\s+done)/.test(t)) return 'COMPLETE';

  // Create pact — has a due date indicator
  if (/\b(by|due|before|until)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/.test(t)) return 'CREATE';
  if (/\b(i\s+need\s+to|i\s+have\s+to|i\s+will|i'll|i\s+must|need\s+to|going\s+to|gonna|create\s+a\s+pact|make\s+a\s+pact|new\s+pact)\b/.test(t)) return 'CREATE';

  return 'UNKNOWN';
}

async function getUserPacts(userId) {
  const result = await pool.query(
    `SELECT * FROM pacts
     WHERE (creator_slack_id = $1 OR counterparty_slack_id = $1) AND status = 'active'
     ORDER BY due_date ASC NULLS LAST, created_at DESC
     LIMIT 10`,
    [userId]
  );
  return result.rows;
}

async function getUserNameById(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    const profile = info.user.profile;
    return profile.display_name || info.user.real_name || info.user.name || userId;
  } catch {
    return userId;
  }
}

async function handleDMMessage(event, client) {
  // Ignore bot messages, message edits, and anything with a subtype
  if (event.subtype || event.bot_id) return;
  if (!event.text) return;

  const userId = event.user;
  const channelId = event.channel;

  // Strip bot @mentions from the start (in case user @mentions the bot)
  const cleanText = event.text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();

  const intent = detectIntent(cleanText);

  try {
    switch (intent) {
      case 'GREETING':    return handleDMGreeting(client, userId, channelId);
      case 'WHAT_IS':     return handleDMWhatIs(client, userId, channelId);
      case 'HELP':        return handleDMHelpMessage(client, userId, channelId);
      case 'LIST_PACTS':  return handleDMListPacts(client, userId, channelId);
      case 'COMPLETE':    return doneRoutes.handleDMComplete(client, userId, channelId, cleanText, tracker);
      case 'CREATE':      return handleDMCreatePact(client, userId, channelId, cleanText);
      default:            return handleDMUnknown(client, userId, channelId, cleanText);
    }
  } catch (err) {
    console.error('DM handler error:', err.message);
    await client.chat.postMessage({
      channel: channelId,
      text: ':x: Something went wrong. Try again or type `help` for options.'
    });
  }
}

async function handleDMGreeting(client, userId, channelId) {
  const [userName, pacts] = await Promise.all([
    getUserNameById(client, userId),
    getUserPacts(userId),
  ]);

  if (pacts.length === 0) {
    // First-timer — full onboarding message
    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:wave: Hey ${userName}! I'm *Pact* — your accountability partner in Slack.\n\nPact helps you and a teammate keep each other honest. Make a commitment, set a deadline, and I'll remind you both before it's due.`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Make your first pact in 10 seconds:*\n1. Open a DM with a teammate\n2. Type \`/pact [what you'll do] by [when]\`\n3. Done — I'll handle the reminders`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Example:*\n\`/pact Review the Q2 roadmap by Friday\``
          }
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'You can also tell me a commitment here — I\'ll help you track it :memo:' }
          ]
        }
      ],
      text: `Hey ${userName}! I'm Pact. Type 'help' to see what I can do.`
    });
  } else {
    // Returning user — quick status
    await client.chat.postMessage({
      channel: channelId,
      text: `:wave: Hey ${userName}! You have *${pacts.length} active pact${pacts.length === 1 ? '' : 's'}*. Say "my pacts" to see them, or head to a DM with a teammate to make a new one.`
    });
  }
}

async function handleDMWhatIs(client, userId, channelId) {
  await client.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:handshake: *Pact is accountability, built into Slack.*\n\nWhen you commit to something with a teammate — "I'll review your PR by Thursday" — Pact records it and reminds you both before the deadline. No more forgotten handoffs.`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Commands:*\n• \`/pact [task] by [date]\` — create a commitment in a DM with a teammate\n• \`/pacts\` — see all active pacts in that conversation\n• \`/done\` — mark a pact complete\n• \`/pact feedback <message>\` — send us feedback or a question\n\n*Here in the bot DM:*\n• "my pacts" — see all your commitments\n• "done" — mark something complete\n• Just describe a task with a date to create a self-pact`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Try it now:* Open a DM with a teammate and type:\n\`/pact Ship the landing page by next Monday\``
        }
      }
    ],
    text: 'Pact is accountability built into Slack.'
  });
}

async function handleDMHelpMessage(client, userId, channelId, teamId) {
  const helpTier = teamId ? await getTeamTier(teamId) : 'free';
  const badge = planBadge(helpTier);
  const planNote = helpTier === 'pro'
    ? `${badge} — Unlimited pacts + Linear, Notion, Asana sync`
    : `${badge} — Up to 100 pacts/month · _/pact upgrade_ to go Pro`;

  const { blocks, text } = buildOnboardingBlocks('help');

  // Append tier badge as a trailing context block
  const blocksWithTier = [
    ...blocks,
    { type: 'context', elements: [{ type: 'mrkdwn', text: planNote }] }
  ];

  await client.chat.postMessage({ channel: channelId, blocks: blocksWithTier, text });
}

// Build Slack blocks for a pact list — used by both "my pacts" DM query and daily digest.
// headerText: the top-level header line (e.g. "📋 Your active pacts:" or "☀️ Good morning! ...")
// client: Slack client for counterparty resolution (optional)
async function buildPactsBlocks(pacts, userId, headerText, client, plan) {
  // Resolve null counterparties + fetch user timezone in parallel
  const [, userTz] = await Promise.all([
    client ? resolveNullCounterparties(pacts, userId, client, pool, botUserId) : Promise.resolve(),
    client ? getUserTimezone(client, userId) : Promise.resolve('America/New_York'),
  ]);

  // Partition into creator / assignee / solo
  const myPacts       = pacts.filter(p => p.creator_slack_id === userId && p.counterparty_slack_id !== userId);
  const assignedPacts = pacts.filter(p => p.counterparty_slack_id === userId && p.creator_slack_id !== userId);
  const soloPacts     = pacts.filter(p => p.creator_slack_id === userId && (p.counterparty_slack_id === userId || !p.counterparty_slack_id));

  // Remove from soloPacts any that are already in myPacts (creator with null counterparty)
  const myPactIds = new Set(myPacts.map(p => p.id));
  const assignedPactIds = new Set(assignedPacts.map(p => p.id));
  const filteredSoloPacts = soloPacts.filter(p => !myPactIds.has(p.id) && !assignedPactIds.has(p.id));

  function fmtCard(pact, isCreator) {
    const emoji = getStatusEmoji(pact.due_date);
    const dueStr = pact.due_date ? formatDate(new Date(pact.due_date), userTz) : 'No due date';
    const label = getStatusLabel(pact.due_date);
    const suffix = label ? ` _(${label})_` : '';

    let personStr;
    if (isCreator) {
      personStr = pact.counterparty_slack_id
        ? `with <@${pact.counterparty_slack_id}>`
        : 'with a teammate';
    } else {
      personStr = `from <@${pact.creator_slack_id}>`;
    }

    return `${emoji}  *"${pact.description}"*\n      Due: ${dueStr} · ${personStr}${suffix}`;
  }

  function fmtSoloCard(pact) {
    const emoji = getStatusEmoji(pact.due_date);
    const dueStr = pact.due_date ? formatDate(new Date(pact.due_date), userTz) : 'No due date';
    const label = getStatusLabel(pact.due_date);
    const suffix = label ? ` _(${label})_` : '';

    return `${emoji}  *"${pact.description}"*\n      Due: ${dueStr}${suffix}`;
  }

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: headerText } }
  ];

  if (myPacts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Pacts you made:*` }
    });
    for (const pact of myPacts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: fmtCard(pact, true) }
      });
    }
  }

  if (assignedPacts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Pacts assigned to you:*` }
    });
    for (const pact of assignedPacts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: fmtCard(pact, false) }
      });
    }
  }

  if (filteredSoloPacts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Solo commitments:*` }
    });
    for (const pact of filteredSoloPacts) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: fmtSoloCard(pact) }
      });
    }
  }

  const badge = planBadge(plan || 'free');
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Say "done" to complete a pact, or use \`/done [#]\` in the original DM  ·  ${badge}` }]
  });

  return blocks;
}

async function handleDMListPacts(client, userId, channelId) {
  const pacts = await getUserPacts(userId);

  if (pacts.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: 'No active pacts. Open a DM with a teammate and use `/pact [task] by [date]` to create one.'
    });
    return;
  }

  const teamId = pacts[0]?.team_id;
  const plan = teamId ? await getTeamTier(teamId) : 'free';
  const blocks = await buildPactsBlocks(pacts, userId, `📋 *Your active pacts (${pacts.length}):*`, client, plan);

  await client.chat.postMessage({
    channel: channelId,
    blocks,
    text: `You have ${pacts.length} active pact${pacts.length === 1 ? '' : 's'}.`
  });
}

async function handleDMCreatePact(client, userId, channelId, text) {
  const { description, dueDate } = parseDueDate(text);

  // Check for @mention of a counterparty
  const mentionMatch = text.match(/<@([A-Z0-9]+)>/);
  const counterpartyId = mentionMatch ? mentionMatch[1] : null;

  // Strip the mention from description
  const cleanDescription = description.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim() || description;

  const [userName, userTz] = await Promise.all([getUserNameById(client, userId), getUserTimezone(client, userId)]);
  const dueDateStr = dueDate ? formatDate(dueDate, userTz) : 'No due date';
  const isSolo = !counterpartyId;

  let confirmText;
  if (counterpartyId) {
    confirmText = `*${cleanDescription}*\nDue: *${dueDateStr}*\nWith: <@${counterpartyId}>`;
  } else {
    confirmText = `*${cleanDescription}*\nDue: *${dueDateStr}*\n_Solo commitment — just you_`;
  }

  // Encode pending pact data in button value (max 2000 chars)
  const pendingData = JSON.stringify({
    description: cleanDescription.substring(0, 500),
    dueDate: dueDate ? dueDate.toISOString() : null,
    counterpartyId: counterpartyId || userId, // default to self
    channelId,
    creatorName: userName,
  });

  await client.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:handshake: *Create this pact?*\n\n${confirmText}`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'dm_confirm_pact',
            text: { type: 'plain_text', text: '✅ Yes, create it', emoji: true },
            style: 'primary',
            value: pendingData.substring(0, 2000),
          },
          {
            type: 'button',
            action_id: 'dm_cancel_pact',
            text: { type: 'plain_text', text: '✗ Cancel', emoji: true },
            value: 'cancel',
          }
        ]
      }
    ],
    text: `Create pact: ${cleanDescription}?`
  });
}

async function handleDMComplete(client, userId, channelId, text) {
  // Check if they specified a pact ID
  const idMatch = text.match(/#?(\d+)/);
  if (idMatch) {
    await completePact(parseInt(idMatch[1]), userId, channelId, client);
    return;
  }

  const pacts = await getUserPacts(userId);

  if (pacts.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':white_check_mark: You have no active pacts to complete!'
    });
    return;
  }

  if (pacts.length === 1) {
    await completePact(pacts[0].id, userId, channelId, client);
    return;
  }

  const options = pacts.slice(0, 10).map(pact => ({
    text: { type: 'plain_text', text: `#${pact.id}: ${pact.description.substring(0, 65)}` },
    value: String(pact.id)
  }));

  await client.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':white_check_mark: *Which pact did you complete?*' },
        accessory: {
          type: 'static_select',
          action_id: 'dm_select_pact_complete',
          placeholder: { type: 'plain_text', text: 'Pick a pact…' },
          options
        }
      }
    ],
    text: 'Which pact did you complete?'
  });
}

async function handleDMUnknown(client, userId, channelId, text) {
  const isAck = /^(thanks|thank you|ok|okay|got it|cool|nice|great|sounds good|roger|ack|k|👍|🙏)$/i.test(text.trim());
  if (isAck) return; // No response needed for simple acks

  const isSubstantial = text.length > 15;

  if (isSubstantial) {
    // Probably a commitment without a due date — nudge them
    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `That sounds like a commitment! I just need a due date to track it. Try:\n\n_"${text.substring(0, 80)} by Friday"_\n\nOr use \`/pact [task] by [date]\` in a DM with a teammate.`
          }
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'Not what you meant? Type `help` for all commands, or `/pact feedback <message>` to reach a human.' }
          ]
        }
      ],
      text: "Looks like a commitment — add a due date and I'll track it."
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Hey! I'm a bot, but I'm not ignoring you. :slightly_smiling_face:\n\nHere's what I can do:\n• *"my pacts"* — see your active commitments\n• *"done"* — mark something complete\n• *"help"* — all commands\n\nNeed a human? Use \`/pact feedback <message>\` and someone will see it. Or email *hello@makepact.co* directly.`
          }
        }
      ],
      text: "Hey! I'm a bot. Try 'help' for commands, or /pact feedback to reach a human."
    });
  }
}

// DM action: confirm pact creation
async function handleDMConfirmPact({ action, ack, body, client }) {
  await ack();

  const userId = body.user.id;
  const channelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts;

  let pendingData;
  try {
    pendingData = JSON.parse(action.value);
  } catch {
    await client.chat.postMessage({ channel: channelId, text: ':x: Pact data was lost. Please try again.' });
    return;
  }

  const { description, dueDate, counterpartyId, creatorName } = pendingData;
  const teamId = body.team?.id;

  try {
    const isSolo = counterpartyId === userId;
    const [counterpartyName, creatorTz, counterpartyTz] = await Promise.all([
      getUserNameById(client, counterpartyId),
      getUserTimezone(client, userId),
      isSolo ? Promise.resolve('America/New_York') : getUserTimezone(client, counterpartyId),
    ]);
    const dueDateValue = dueDate ? new Date(dueDate) : null;

    const result = await pool.query(
      `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                          counterparty_slack_id, counterparty_name, description, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [teamId, channelId, userId, creatorName, counterpartyId, counterpartyName, description, dueDateValue]
    );

    const pactId = result.rows[0].id;

    // Mark first_pact_created on the installation record if this creator is the installer
    pool.query(
      `UPDATE installations SET first_pact_created = TRUE
       WHERE team_id = $1 AND installer_user_id = $2 AND first_pact_created = FALSE`,
      [teamId, userId]
    ).catch((err) => console.error('[onboarding] Failed to mark first_pact_created:', err.message));

    // Quality signal for invite Pro grant: this workspace created a pact within 7d of install
    require('../db/invites').markInvitePactCreated(teamId).catch(() => {});

    const dueDateStr = dueDateValue ? formatDate(dueDateValue, creatorTz) : 'No due date';
    const cpDueDateStr = dueDateValue ? formatDate(dueDateValue, counterpartyTz) : 'No due date';

    // Delete the confirmation message
    if (messageTs) {
      await client.chat.delete({ channel: channelId, ts: messageTs }).catch(() => {});
    }

    // Post success — capture ts so ✅/👍 reactions can complete the pact
    const confirmMsg = await client.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `:white_check_mark: *Pact #${pactId} created!*`,
              `_${description}_`,
              `Due: *${dueDateStr}*`,
              isSolo
                ? ':alarm_clock: I\'ll remind you before the deadline.'
                : `<@${counterpartyId}> has been notified.`,
              '',
              `_React ✅ or 👍 to mark it done._`
            ].join('\n')
          }
        }
      ],
      text: `Pact #${pactId} created: ${description}`
    });

    // Store confirmation location for reaction-completion
    if (confirmMsg?.ts) {
      pactsDb.updatePactConfirmation(pactId, channelId, confirmMsg.ts).catch(err =>
        console.error(`[DM-CONFIRM] Failed to store confirmation ts for pact ${pactId}:`, err.message)
      );
    }

    // Notify counterparty if not solo
    if (!isSolo) {
      try {
        const cpDM = await client.conversations.open({ users: counterpartyId });
        await client.chat.postMessage({
          channel: cpDM.channel.id,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `:handshake: *${creatorName} made a pact with you!*`,
                  `_${description}_`,
                  `Due: *${cpDueDateStr}*`,
                  '',
                  `I'll remind you both. Type \`/done ${pactId}\` when it's done.`
                ].join('\n')
              }
            }
          ],
          text: `${creatorName} made a pact with you: ${description} (due ${cpDueDateStr})`
        });
      } catch (notifyErr) {
        console.error('Could not notify counterparty:', notifyErr.message);
      }
    }
  } catch (err) {
    console.error('DM pact creation error:', err.message);
    await client.chat.postMessage({ channel: channelId, text: ':x: Failed to create pact. Please try again.' });
  }
}

// DM action: cancel pact creation
async function handleDMCancelPact({ action, ack, body, client }) {
  await ack();
  const channelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts;

  if (messageTs) {
    await client.chat.delete({ channel: channelId, ts: messageTs }).catch(() => {});
  }

  await client.chat.postMessage({
    channel: channelId,
    text: ':ok: No problem! Let me know when you want to make a pact.'
  });
}

// Legacy no-op handlers: accept/decline buttons were removed in the redesign.
// These remain registered so old messages with buttons don't 404.
async function handleAcceptDmPact({ ack, respond }) {
  await ack();
  await respond({ replace_original: false, text: 'Pacts are now created instantly — no acceptance needed. Use `/pact` to create a new one.' });
}

async function handleDeclineDmPact({ ack, respond }) {
  await ack();
  await respond({ replace_original: false, text: 'Pacts are now created instantly — no acceptance needed.' });
}

// DM action: select pact to complete (from dropdown)
async function handleDMSelectPactComplete({ action, ack, body, client }) {
  await ack();
  const pactId = parseInt(action.selected_option.value);
  const userId = body.user.id;
  const dmChannelId = body.channel?.id || body.container?.channel_id;

  // Look up the pact's actual channel_id — the DM picker lives in the bot DM
  // which is different from the channel where the pact was originally created.
  let channelId = dmChannelId;
  try {
    const pactRow = await pool.query('SELECT channel_id FROM pacts WHERE id = $1', [pactId]);
    if (pactRow.rows.length > 0) {
      channelId = pactRow.rows[0].channel_id;
    }
  } catch (e) {
    console.error('[dm_select_pact_complete] channel lookup failed:', e.message);
  }

  if (channelId) {
    await completePact(pactId, userId, channelId, client);
  }
}

// ---------------------------------------------------------------------------
// Emoji-Reaction → Pact Flow
// ---------------------------------------------------------------------------
// When a user reacts to any message with the workspace's trigger emoji
// (default: 🤝 handshake), we send them an ephemeral DM with a pre-filled
// confirmation block. They can swap promiser/recipient, confirm, and create
// the pact — all without typing a single command.
//
// Required Slack scopes (beyond existing): reactions:read, channels:history,
//   groups:history, im:history, mpim:history
// Required event subscription: reaction_added

/**
 * Get the workspace's configured trigger emoji. Falls back to 'handshake'.
 */
async function getTriggerEmoji(teamId) {
  try {
    const row = await pool.query(
      `SELECT trigger_emoji FROM installations WHERE team_id = $1 LIMIT 1`,
      [teamId]
    );
    return row.rows[0]?.trigger_emoji || 'handshake';
  } catch {
    return 'handshake';
  }
}

/**
 * Build the ephemeral confirmation blocks for a reaction-triggered pact.
 * Shows the original message text, promiser, recipient, and a date input.
 */
function buildReactionConfirmBlocks({ messageText, promiserId, recipientId, pactData, swapped }) {
  const truncated = (messageText || '').substring(0, 300).trim() || '(message text unavailable)';
  const pendingJson = JSON.stringify(pactData).substring(0, 2000);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:handshake: *Turn this message into a pact?*\n\n_"${truncated}"_`
      }
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Promiser (who commits):*\n<@${promiserId}>`
        },
        {
          type: 'mrkdwn',
          text: `*Recipient (who holds accountable):*\n<@${recipientId}>`
        }
      ]
    },
    {
      type: 'input',
      block_id: 'reaction_due_date',
      optional: true,
      label: { type: 'plain_text', text: 'Due date (optional — edit or add below)' },
      element: {
        type: 'plain_text_input',
        action_id: 'due_date_input',
        placeholder: { type: 'plain_text', text: 'e.g. Friday 5pm, next Monday, 2026-05-15' },
        initial_value: '',
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'reaction_confirm_pact',
          text: { type: 'plain_text', text: '✅ Create Pact', emoji: true },
          style: 'primary',
          value: pendingJson,
        },
        {
          type: 'button',
          action_id: 'reaction_swap_parties',
          text: { type: 'plain_text', text: `${swapped ? '↩ Swap back' : '⇄ Swap roles'}`, emoji: true },
          value: pendingJson,
        },
        {
          type: 'button',
          action_id: 'reaction_cancel_pact',
          text: { type: 'plain_text', text: '✗ Cancel', emoji: true },
          value: 'cancel',
        }
      ]
    }
  ];
}

/**
 * Main handler for reaction_added events.
 * Fires when any user adds a reaction to any message in a channel/DM
 * that the bot is subscribed to.
 */
async function handleReactionAdded({ event, client, body }) {
  const { reaction, user: reactorId, item, item_user: messageAuthorId } = event;
  // team_id lives at body.team_id in Slack's event payload, NOT inside event.item
  const teamId = body?.team_id || event?.team_id || null;

  console.log(`[REACTION] Event received: reaction=${reaction} user=${reactorId} item_type=${item?.type} team=${teamId}`);

  // Only handle DMs and channels (type: 'message')
  if (item?.type !== 'message') return;

  const channelId = item.channel;
  const messageTs = item.ts;

  // -------------------------------------------------------------------------
  // ✅ / 👍 on a pact confirmation message → complete the pact
  // -------------------------------------------------------------------------
  if (reaction === 'white_check_mark' || reaction === 'thumbsup') {
    console.log(`[REACTION] Completion reaction: ${reaction} by ${reactorId} on msg ${messageTs} in ${channelId}`);
    try {
      const pact = await pactsDb.getPactByConfirmation(channelId, messageTs);
      if (pact) {
        // Only the promiser (creator_slack_id) can mark it done this way
        if (pact.creator_slack_id !== reactorId) {
          // Send an ephemeral — silently ignore if we can't open DM
          try {
            const dmResult = await client.conversations.open({ users: reactorId });
            await client.chat.postEphemeral({
              channel: dmResult.channel.id,
              user: reactorId,
              text: `:information_source: Only the promiser (<@${pact.creator_slack_id}>) can mark this pact as done.`
            });
          } catch {}
          return;
        }

        console.log(`[REACTION] Completing pact #${pact.id} via ${reaction} by ${reactorId}`);
        // Reuse the existing completePact function (posts to pact's channel, notifies counterparty, syncs tracker)
        await completePact(pact.id, reactorId, channelId, client);
      }
      // If no pact found, the reaction is on some other message — ignore
    } catch (err) {
      console.error(`[REACTION] Error handling completion reaction: ${err.message}`);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Get this workspace's configured trigger emoji
  const triggerEmoji = await getTriggerEmoji(teamId || '').catch(() => 'handshake');

  // Only fire on the trigger emoji
  if (reaction !== triggerEmoji) {
    console.log(`[REACTION] Skipped: reaction=${reaction} != trigger=${triggerEmoji}`);
    return;
  }

  console.log(`[REACTION] Matched! ${reaction} by ${reactorId} on msg ${messageTs} in channel ${channelId}`);

  try {
    // Fetch the original message to get its text
    let originalText = '';
    try {
      const history = await client.conversations.history({
        channel: channelId,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      });
      originalText = history.messages?.[0]?.text || '';
    } catch (err) {
      console.warn(`[REACTION] Could not fetch message history for channel ${channelId}: ${err.message}`);
      // Continue — we'll show an empty commitment field
    }

    // Determine promiser and recipient.
    // Default: message author is the promiser, reactor is the recipient.
    // If the reactor IS the author, default to reactor as promiser, no recipient (solo pact).
    const messageAuthor = messageAuthorId || null;
    const isSelfReact = messageAuthor && messageAuthor === reactorId;

    const promiserId = messageAuthor || reactorId;
    const recipientId = isSelfReact ? reactorId : reactorId;

    // Build pending data payload
    const pactData = {
      messageText: originalText.substring(0, 500),
      originalMessageTs: messageTs,
      channelId,
      promiserId,
      recipientId,
      reactorId,
      teamId,
      swapped: false,
    };

    // Open a DM to the reactor to deliver the ephemeral confirmation
    let dmChannelId;
    try {
      const dmResult = await client.conversations.open({ users: reactorId });
      dmChannelId = dmResult.channel.id;
    } catch (err) {
      console.error(`[REACTION] Could not open DM with reactor ${reactorId}: ${err.message}`);
      return;
    }

    const blocks = buildReactionConfirmBlocks({
      messageText: originalText,
      promiserId,
      recipientId,
      pactData,
      swapped: false,
    });

    await client.chat.postMessage({
      channel: dmChannelId,
      text: ':handshake: Turn this message into a pact?',
      blocks,
    });

  } catch (err) {
    console.error(`[REACTION] Unhandled error in handleReactionAdded: ${err.message}`);
  }
}

/**
 * Action: user confirms pact creation from the reaction flow.
 * Reads due date from state if provided, creates pact, notifies parties.
 */
async function handleReactionConfirmPact({ action, ack, body, client }) {
  await ack();

  const userId = body.user.id;
  const msgChannelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts;

  let pactData;
  try {
    pactData = JSON.parse(action.value);
  } catch {
    await client.chat.postMessage({ channel: msgChannelId, text: ':x: Pact data was lost. Please react again.' });
    return;
  }

  // Extract due date from block kit state (the plain text input)
  const state = body.state?.values || {};
  const dueDateRaw = state['reaction_due_date']?.due_date_input?.value || '';
  let dueDate = null;
  if (dueDateRaw.trim()) {
    const parsed = parseDueDate(dueDateRaw.trim());
    dueDate = parsed.dueDate || null;
  }

  const { messageText, promiserId, recipientId, teamId } = pactData;
  const description = messageText.substring(0, 500) || '(commitment from Slack message)';

  try {
    // Enforce monthly pact limits
    const resolvedTeamId = teamId || body.team?.id;
    if (resolvedTeamId) {
      const teamTier = await getTeamTier(resolvedTeamId);
      const monthlyLimit = PLAN_MONTHLY_LIMITS[teamTier];
      if (monthlyLimit !== null) {
        const monthlyCount = await getMonthlyPactCount(resolvedTeamId);
        if (monthlyCount >= monthlyLimit) {
          await client.chat.update({
            channel: msgChannelId,
            ts: messageTs,
            text: `:warning: Your workspace has hit the *${monthlyLimit} pacts/month* limit on the Free plan. Upgrade to Pro for unlimited pacts: <https://makepact.co/#pricing|makepact.co/#pricing>`,
            blocks: []
          });
          return;
        }
      }
    }

    const isSolo = promiserId === recipientId;
    const [promiserName, promiserTz, recipientTz, recipientName] = await Promise.all([
      getUserName(client, promiserId),
      getUserTimezone(client, promiserId),
      isSolo ? Promise.resolve('America/New_York') : getUserTimezone(client, recipientId),
      isSolo ? Promise.resolve(null) : getUserName(client, recipientId),
    ]);
    const dueDateStr = dueDate ? formatDate(dueDate, promiserTz) : 'No due date set';
    const recipientDueDateStr = dueDate ? formatDate(dueDate, recipientTz) : 'No due date set';

    // Insert the pact
    const result = await pool.query(
      `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                          counterparty_slack_id, counterparty_name, description, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       RETURNING id`,
      [
        resolvedTeamId || null,
        msgChannelId,
        promiserId,
        promiserName,
        isSolo ? null : recipientId,
        isSolo ? null : recipientName,
        description,
        dueDate,
      ]
    );
    const pactId = result.rows[0].id;

    // Mark first_pact_created if this creator is the installer
    if (resolvedTeamId) {
      pool.query(
        `UPDATE installations SET first_pact_created = TRUE
         WHERE team_id = $1 AND installer_user_id = $2 AND first_pact_created = FALSE`,
        [resolvedTeamId, userId]
      ).catch(err => console.error('[onboarding] Failed to mark first_pact_created:', err.message));

      // Quality signal for invite Pro grant
      require('../db/invites').markInvitePactCreated(resolvedTeamId).catch(() => {});
    }

    // First-pact celebration DM
    triggerFirstPactCelebration({
      creatorId: promiserId,
      teamId: resolvedTeamId || null,
      counterpartyName: isSolo ? null : recipientName,
    });

    // Async tracker sync
    if (resolvedTeamId) {
      tracker.syncPactToTracker(
        pool,
        { id: pactId, description, due_date: dueDate, team_id: resolvedTeamId, creator_name: promiserName, counterparty_name: recipientName },
        resolvedTeamId,
        { creatorSlackId: promiserId }
      );
    }

    // Update the confirmation message to show success
    const successText = isSolo
      ? `:white_check_mark: *Pact #${pactId} created!*\n_${description}_\nDue: *${dueDateStr}*\n:alarm_clock: I'll remind you before the deadline.\n\n_React ✅ or 👍 to this message to mark it done._`
      : `:white_check_mark: *Pact #${pactId} created!*\n_${description}_\nDue: *${dueDateStr}*\n<@${recipientId}> has been notified.\n\n_React ✅ or 👍 to this message to mark it done._`;

    await client.chat.update({
      channel: msgChannelId,
      ts: messageTs,
      text: `Pact #${pactId} created`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: successText }
        }
      ]
    });

    // Store the confirmation message location so ✅/👍 reactions can complete the pact
    if (msgChannelId && messageTs) {
      pactsDb.updatePactConfirmation(pactId, msgChannelId, messageTs).catch(err =>
        console.error(`[REACTION] Failed to store confirmation ts for pact ${pactId}:`, err.message)
      );
    }

    // Notify the recipient if not solo
    if (!isSolo && recipientId !== userId) {
      try {
        const recipientDM = await client.conversations.open({ users: recipientId });
        const recipientName = await getUserName(client, recipientId);
        await client.chat.postMessage({
          channel: recipientDM.channel.id,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `:handshake: *${promiserName} made a pact with you!*`,
                  `_${description}_`,
                  `Due: *${recipientDueDateStr}*`,
                  '',
                  `I'll remind you both. Type \`/done ${pactId}\` when it's done.`
                ].join('\n')
              }
            }
          ],
          text: `${promiserName} made a pact with you: ${description} (due ${recipientDueDateStr})`
        });
      } catch (notifyErr) {
        console.error(`[REACTION] Could not notify recipient ${recipientId}: ${notifyErr.message}`);
      }
    }

  } catch (err) {
    console.error(`[REACTION] Error creating pact: ${err.message}`);
    await client.chat.postMessage({ channel: msgChannelId, text: ':x: Failed to create the pact. Please try again.' });
  }
}

/**
 * Action: swap promiser ↔ recipient roles before confirming.
 */
async function handleReactionSwapParties({ action, ack, body, client }) {
  await ack();

  const msgChannelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts;

  let pactData;
  try {
    pactData = JSON.parse(action.value);
  } catch {
    await client.chat.postMessage({ channel: msgChannelId, text: ':x: Pact data was lost. Please react again.' });
    return;
  }

  // Swap
  const { promiserId, recipientId } = pactData;
  pactData.promiserId = recipientId;
  pactData.recipientId = promiserId;
  pactData.swapped = !pactData.swapped;

  const blocks = buildReactionConfirmBlocks({
    messageText: pactData.messageText,
    promiserId: pactData.promiserId,
    recipientId: pactData.recipientId,
    pactData,
    swapped: pactData.swapped,
  });

  await client.chat.update({
    channel: msgChannelId,
    ts: messageTs,
    text: ':handshake: Turn this message into a pact?',
    blocks,
  });
}

/**
 * Action: cancel the reaction pact flow.
 */
async function handleReactionCancelPact({ ack, body, client }) {
  await ack();
  const msgChannelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts;

  if (messageTs) {
    await client.chat.update({
      channel: msgChannelId,
      ts: messageTs,
      text: ':ok: No problem! React with 🤝 again anytime to turn a message into a pact.',
      blocks: []
    }).catch(() => {});
  }
}


// ---------------------------------------------------------------------------
// First-Pact Onboarding DM Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared onboarding block kit builder — single source of truth for welcome
// DM and /pact help. Mode 'welcome' = full install primer; 'help' = condensed
// command reference. Edit once, both surfaces stay in sync.
// ---------------------------------------------------------------------------
function buildOnboardingBlocks(mode, opts = {}) {
  const PRODUCT_URL = getAppUrl();
  const { invitedByName = null } = opts;

  // The magic moment block — shown in welcome, omitted in condensed help
  const magicMomentBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: ':handshake: *The magic moment:* React to any Slack message with 🤝 and Pact turns it into a tracked commitment — instantly. No slash command, no context-switch. Just react and it\'s done.'
    }
  };

  // Three core verbs
  const coreVerbsBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Three things to know:*\n• *Create* — `/pact [task] by [date]` in any DM, or react 🤝 to a message\n• *Track* — `/pacts` to see everything in flight\n• *Close* — `/done` when you\'ve followed through'
    }
  };

  // Full command reference — only in help mode
  const fullCommandsBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*All commands:*\n• `/pact [task] by [date]` — create a pact\n• `/pacts` — list active pacts\n• `/done` — mark complete (picker or fuzzy match)\n• `/done 5` — complete pact #5 directly\n• `/pact edit [id] [new text]` — update description\n• `/pact extend [id] to [date]` — push deadline\n• `/pact settings` — reminders, timezone, tracker connections\n• `/pact invite` — get your invite link (invite 2 teams → 30 days Pro free)\n• `/pact upgrade` — upgrade to Pro\n• `/pact billing` — manage your Pro subscription\n• `/pact feedback [msg]` — send us a note'
    }
  };

  // Product page link
  const learnMoreBlock = {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `:globe_with_meridians: <${PRODUCT_URL}|See a 30-second demo and full docs> · Questions? *hello@makepact.co*`
    }]
  };

  if (mode === 'welcome') {
    const invitedBlock = invitedByName
      ? [{ type: 'section', text: { type: 'mrkdwn', text: `_Invited by *${invitedByName}* — they\u2019re already using Pact with their team._` } }]
      : [];

    return {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Pact is in.* :white_check_mark:\n\nSay goodbye to commitments that slip through DMs. Pact tracks every promise your team makes — and reminds both sides before the deadline.'
          }
        },
        ...invitedBlock,
        { type: 'divider' },
        magicMomentBlock,
        { type: 'divider' },
        coreVerbsBlock,
        { type: 'divider' },
        learnMoreBlock,
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: ':zap: *Pact Pro* unlocks AI-powered `/done` and Workflow Builder steps — try `/pact upgrade` anytime.' }]
        }
      ],
      text: 'Pact is ready! React 🤝 to any message to create a pact, or type /pact [task] by [date] in a DM. Use /pact help anytime for commands.'
    };
  }

  // mode === 'help' — condensed, no magic-moment callout
  return {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':wave: *Pact commands:*' }
      },
      coreVerbsBlock,
      { type: 'divider' },
      fullCommandsBlock,
      { type: 'divider' },
      learnMoreBlock
    ],
    text: 'Pact commands: /pact [task] by [date] to create, /pacts to list, /done to close. React 🤝 to any message to create from context.'
  };
}

// Send welcome DM to the installer after OAuth install
async function sendWelcomeDM(botToken, installerUserId, teamName, invitedByName = null) {
  const { WebClient } = require('@slack/web-api');
  const client = new WebClient(botToken);

  // Open a DM channel with the installer
  const dmResponse = await client.conversations.open({ users: installerUserId });
  if (!dmResponse.ok || !dmResponse.channel?.id) {
    console.error(`[onboarding] Could not open DM with user ${installerUserId}: ${dmResponse.error}`);
    return;
  }

  const channelId = dmResponse.channel.id;
  const { blocks, text } = buildOnboardingBlocks('welcome', { invitedByName });

  await client.chat.postMessage({ channel: channelId, blocks, text });

  console.log(`[onboarding] Welcome DM sent to installer ${installerUserId} in team ${teamName}${invitedByName ? ` (invited by ${invitedByName})` : ''}`);
}

// Send 24-hour nudge DM to installers who haven't created their first pact
async function sendNudgeDM(botToken, installerUserId, teamName) {
  const { WebClient } = require('@slack/web-api');
  const client = new WebClient(botToken);

  const dmResponse = await client.conversations.open({ users: installerUserId });
  if (!dmResponse.ok || !dmResponse.channel?.id) {
    console.error(`[onboarding] Nudge: Could not open DM with user ${installerUserId}: ${dmResponse.error}`);
    return;
  }

  const channelId = dmResponse.channel.id;

  await client.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Still haven't made your first pact? :thinking_face:\n\nPick someone you're waiting on and open a DM with them. Then type:\n\n> /pact [what they owe you] by [when]\n\nI'll make sure neither of you forgets.`
        }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `No spam from me after this — just wanted to make sure you had a chance to try. :slightly_smiling_face:` }
        ]
      }
    ],
    text: `Still haven't made your first pact? Try /pact in a DM with a teammate.`
  });

  console.log(`[onboarding] 24h nudge DM sent to installer ${installerUserId} in team ${teamName}`);
}

// Check for workspaces that need the 24-hour nudge and send it
async function checkNudgeDue(pool) {
  try {
    // Find installations where:
    // - No pacts have been created yet
    // - 24h nudge hasn't been sent
    // - More than 24 hours have passed since install
    const result = await pool.query(`
      SELECT i.team_id, i.installer_user_id, i.team_name, i.bot_token
      FROM installations i
      LEFT JOIN pacts p ON p.team_id = i.team_id
      WHERE p.id IS NULL
        AND i.installer_user_id IS NOT NULL
        AND i.nudge_sent_at IS NULL
        AND i.updated_at < NOW() - INTERVAL '24 hours'
    `);

    for (const row of result.rows) {
      try {
        await sendNudgeDM(row.bot_token, row.installer_user_id, row.team_name);
        // Mark nudge as sent so we don't re-send
        await pool.query(
          `UPDATE installations SET nudge_sent_at = NOW() WHERE team_id = $1`,
          [row.team_id]
        );
      } catch (err) {
        console.error(`[onboarding] Nudge failed for team ${row.team_id}:`, err.message);
        trackError(err.message, { tag: 'onboarding-nudge' });
      }
    }
  } catch (err) {
    console.error(`[onboarding] Nudge check error:`, err.message);
    trackError(err.message, { tag: 'onboarding-check' });
  }
}

// ---------------------------------------------------------------------------
// Overdue Pact Nudge
// ---------------------------------------------------------------------------

// Send overdue nudge DMs to both parties of a pact.
async function sendOverdueNudge(client, pact) {
  // Fetch creator's timezone; if there's a counterparty, fetch theirs in parallel
  const hasCounterparty = pact.counterparty_slack_id && pact.counterparty_slack_id !== pact.creator_slack_id;
  const tzFetches = [getUserTimezone(client, pact.creator_slack_id)];
  if (hasCounterparty) tzFetches.push(getUserTimezone(client, pact.counterparty_slack_id));
  const [creatorTz, counterpartyTz] = await Promise.all(tzFetches);

  const dueDateForCreator = formatDate(new Date(pact.due_date), creatorTz);

  // DM committer via the pact's DM channel (bot ↔ committer)
  await client.chat.postMessage({
    channel: pact.channel_id,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏰ *Your pact is overdue:* _${pact.description}_ — was due ${dueDateForCreator}.\nMark it done with /done ${pact.id} or let ${pact.counterparty_name || 'your teammate'} know.`
        }
      }
    ],
    text: `⏰ Your pact is overdue: ${pact.description} — was due ${dueDateForCreator}.`
  });

  // If there's a counterparty who isn't also the committer, DM them separately
  if (hasCounterparty) {
    const dueDateForCp = formatDate(new Date(pact.due_date), counterpartyTz);
    const cpDM = await client.conversations.open({ users: pact.counterparty_slack_id });
    await client.chat.postMessage({
      channel: cpDM.channel.id,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `👀 *${pact.creator_name}'s pact is overdue:* _${pact.description}_ — was due ${dueDateForCp}.`
          }
        }
      ],
      text: `👀 ${pact.creator_name}'s pact is overdue: ${pact.description} — was due ${dueDateForCp}.`
    });
  }
}

// Check for pacts that have passed their due date without being marked complete.
// Nudges once per pact (tracked via overdue_nudge_sent_at).
// Skips pacts overdue more than 7 days — assume they've moved on.
async function checkOverduePacts(pool) {
  try {
    const result = await pool.query(`
      SELECT p.*, i.bot_token
      FROM pacts p
      JOIN installations i ON i.team_id = p.team_id
      WHERE p.status = 'active'
        AND p.due_date < NOW()
        AND p.overdue_nudge_sent_at IS NULL
        AND p.due_date > NOW() - INTERVAL '7 days'
      ORDER BY p.due_date ASC
    `);

    for (const pact of result.rows) {
      try {
        const { WebClient } = require('@slack/web-api');
        const client = new WebClient(pact.bot_token);
        await sendOverdueNudge(client, pact);

        // Mark nudge as sent so we don't re-send on the next run
        await pool.query(
          `UPDATE pacts SET overdue_nudge_sent_at = NOW() WHERE id = $1`,
          [pact.id]
        );

        console.log(`[overdue] Nudged pact #${pact.id} (${pact.creator_name}) — was due ${pact.due_date}`);
      } catch (err) {
        if (err.code === 'channel_not_found' || err.message?.includes('channel_not_found')) {
          // Channel no longer exists — mark nudge as sent to stop the hourly retry loop.
          // A deleted/archived channel won't come back; retrying just pollutes logs.
          await pool.query(
            `UPDATE pacts SET overdue_nudge_sent_at = NOW() WHERE id = $1`,
            [pact.id]
          );
          console.warn(`[overdue] Pact #${pact.id} nudge skipped — channel_not_found. Marked sent to stop retries.`);
        } else {
          console.error(`[overdue] Nudge failed for pact #${pact.id}:`, err.message);
          trackError(err.message, { tag: 'overdue-nudge' });
        }
      }
    }
  } catch (err) {
    console.error(`[overdue] Periodic check error:`, err.message);
    trackError(err.message, { tag: 'overdue-check' });
  }
}

// ---------------------------------------------------------------------------
// Counterparty Nudge (3+ days overdue)
// ---------------------------------------------------------------------------

/**
 * Returns the local hour (0–23) for a given Slack timezone string.
 * Falls back to UTC if the timezone is invalid or missing.
 * WHY: We only want to send counterparty nudges during 9am–6pm the recipient's
 * local time — nobody wants a "your teammate is late" DM at 2am.
 */
function localHourFor(timezone) {
  try {
    const now = new Date();
    const opts = { timeZone: timezone, hour: 'numeric', hour12: false };
    const hourStr = new Intl.DateTimeFormat('en-US', opts).format(now);
    const h = parseInt(hourStr, 10);
    return isNaN(h) ? now.getUTCHours() : h;
  } catch {
    return new Date().getUTCHours();
  }
}

/**
 * DM the counterparty to let them know the pact is 3+ days overdue.
 * Includes a "View my pacts" button that opens the App Home Tab.
 * Tone: informational, empowering — not accusatory.
 */
async function sendCounterpartyNudge(client, pact) {
  const cpDM = await client.conversations.open({ users: pact.counterparty_slack_id });
  const cpTz = await getUserTimezone(client, pact.counterparty_slack_id);
  const dueDateStr = formatDate(new Date(pact.due_date), cpTz);

  await client.chat.postMessage({
    channel: cpDM.channel.id,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `👋 Hey — <@${pact.creator_slack_id}> promised you *"${pact.description}"* and it's now 3+ days overdue (was due ${dueDateStr}).\n\nYou can check in with them directly, or propose a new due date if you'd prefer a different timeline.`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📅 Propose new date', emoji: true },
            style: 'primary',
            action_id: 'propose_reschedule',
            value: String(pact.id),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '📋 View my pacts', emoji: true },
            // Opens App Home Tab — Slack deep-link to app_home surface
            url: `slack://app?team=${pact.team_id}&id=${process.env.SLACK_APP_ID || ''}&tab=home`,
            action_id: 'counterparty_nudge_home_link'
          }
        ]
      }
    ],
    text: `👋 ${pact.creator_name} promised you "${pact.description}" and it's now 3+ days overdue.`
  });
}

/**
 * Check for pacts that are 3+ days overdue and haven't had a counterparty nudge.
 * Rules:
 *   - Only for pacts with a counterparty who is different from the promiser
 *   - Only once per pact (counterparty_nudged_at tracks this)
 *   - Only deliver between 9am–6pm counterparty's local time
 *   - Skip if pact was completed since we queried
 *   - Skip pacts overdue more than 14 days (they've moved on)
 */
async function checkCounterpartyNudges(pool) {
  try {
    const result = await pool.query(`
      SELECT p.*, i.bot_token
      FROM pacts p
      JOIN installations i ON i.team_id = p.team_id
      WHERE p.status = 'active'
        AND p.due_date < NOW() - INTERVAL '3 days'
        AND p.due_date > NOW() - INTERVAL '14 days'
        AND p.counterparty_nudged_at IS NULL
        AND p.counterparty_slack_id IS NOT NULL
        AND p.counterparty_slack_id != p.creator_slack_id
      ORDER BY p.due_date ASC
    `);

    for (const pact of result.rows) {
      try {
        const { WebClient } = require('@slack/web-api');
        const client = new WebClient(pact.bot_token);

        // Fetch counterparty timezone and check delivery window (9am–6pm local)
        const cpTz = await getUserTimezone(client, pact.counterparty_slack_id);
        const localHour = localHourFor(cpTz);
        if (localHour < 9 || localHour >= 18) {
          // Outside delivery window — will retry next hourly check
          continue;
        }

        // Skip if pact was completed between our query and now
        const checkResult = await pool.query(
          `SELECT status FROM pacts WHERE id = $1`,
          [pact.id]
        );
        if (checkResult.rows[0]?.status !== 'active') continue;

        await sendCounterpartyNudge(client, pact);

        await pool.query(
          `UPDATE pacts SET counterparty_nudged_at = NOW() WHERE id = $1`,
          [pact.id]
        );

        console.log(`[cp-nudge] Nudged counterparty for pact #${pact.id} (${pact.creator_name} → ${pact.counterparty_slack_id}) — was due ${pact.due_date}`);
      } catch (err) {
        if (err.code === 'channel_not_found' || err.message?.includes('channel_not_found')) {
          // Can't open DM — mark sent so we don't loop forever
          await pool.query(
            `UPDATE pacts SET counterparty_nudged_at = NOW() WHERE id = $1`,
            [pact.id]
          );
          console.warn(`[cp-nudge] Pact #${pact.id} counterparty nudge skipped — channel_not_found. Marked sent.`);
        } else {
          console.error(`[cp-nudge] Nudge failed for pact #${pact.id}:`, err.message);
          trackError(err.message, { tag: 'cp-nudge' });
        }
      }
    }
  } catch (err) {
    console.error(`[cp-nudge] Periodic check error:`, err.message);
    trackError(err.message, { tag: 'cp-nudge-check' });
  }
}

// ---------------------------------------------------------------------------
// Reminder Thread — Inline Complete
// ---------------------------------------------------------------------------

// Natural language words that mean "done"
const DONE_WORDS = /^(done|finished|complete|completed|yep|yes|yup|👍|✅|confirmed|ok|okay|it['']s done|i['']m done|all done|done!|finished!|yes!)$/i;

/**
 * Handle "✅ Mark Complete" button click from a reminder message.
 * action.value is the pact ID as a string.
 */
async function handleCompleteFromReminder({ ack, body, action, client }) {
  await ack();
  const pactId = parseInt(action.value);
  const userId = body.user.id;
  const channelId = body.channel?.id || body.container?.channel_id;

  if (!pactId || !channelId) {
    console.error('[complete_from_reminder] Missing pactId or channelId');
    return;
  }

  await doneRoutes.completePact(pactId, userId, channelId, client, null, tracker);
}

/**
 * Handle a threaded reply in a DM where the parent message is a reminder.
 * Returns true if the message was handled (completion attempted), false otherwise.
 * WHY: thread_ts ties the reply to a specific pact — no picker needed, zero friction.
 */
async function handleReminderThreadReply(message, client) {
  if (!message.thread_ts || !message.text) return false;
  const cleanText = message.text.trim();
  // Only act on completion signals — don't intercept other thread replies
  if (!DONE_WORDS.test(cleanText)) return false;

  // thread_ts points to the parent message — check if it was a reminder
  const { getPactByReminderTs } = require('../db/pacts');
  const pact = await getPactByReminderTs(message.channel, message.thread_ts);
  if (!pact) return false; // not a reminder thread

  // Complete the pact directly — user is replying in the exact reminder thread
  await doneRoutes.completePact(pact.id, message.user, message.channel, client, null, tracker);
  return true;
}

// ---------------------------------------------------------------------------
// Snooze / Reschedule — reminder DM action handlers
// Counterparty is NOT notified on snooze (too noisy; snooze is a private action).
// last_reminded_at is reset so the new due_date triggers a fresh reminder cycle.
// ---------------------------------------------------------------------------

/**
 * Compute a YYYY-MM-DD date string N calendar days from today (UTC).
 */
function datePlusDays(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * After a successful snooze, send an ephemeral confirmation to the user.
 * WHY: acknowledge the snooze so the user knows it landed — no other confirmation path.
 */
async function sendSnoozeConfirmation(client, channelId, userId, pactId, newDueDate, messageTs) {
  const label = formatDate ? formatDate(new Date(newDueDate)) : newDueDate;
  try {
    await client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      user: userId,
      text: `:alarm_clock: Snoozed. Pact #${pactId} rescheduled to *${label}*. I'll remind you then.`,
    });
  } catch (err) {
    // Ephemeral can fail if channel/user combo is invalid — non-fatal.
    console.error('[snooze] Failed to send confirmation ephemeral:', err.message);
  }
}

/**
 * Handle "⏭ Tomorrow" snooze button on a reminder DM.
 */
async function handleSnoozeTomorrow({ ack, action, body, client }) {
  await ack();
  const pactId = parseInt(action.value, 10);
  const userId = body.user?.id;
  const channelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts || body.container?.message_ts;

  if (!pactId || !userId) return;

  const { snoozePactDueDate } = require('../db/pacts');
  const newDate = datePlusDays(1);
  const updated = await snoozePactDueDate(pactId, userId, newDate);

  if (!updated) {
    // Could be counterparty trying to snooze — only creator can snooze
    try {
      await client.chat.postEphemeral({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        user: userId,
        text: ':x: Only the promise-maker can snooze this pact.',
      });
    } catch {}
    return;
  }

  await sendSnoozeConfirmation(client, channelId, userId, pactId, newDate, messageTs);
  if (homeTab) homeTab.publishHomeTab(client, userId).catch(() => {});
}

/**
 * Handle "⏩ +3 Days" snooze button on a reminder DM.
 */
async function handleSnooze3Days({ ack, action, body, client }) {
  await ack();
  const pactId = parseInt(action.value, 10);
  const userId = body.user?.id;
  const channelId = body.channel?.id || body.container?.channel_id;
  const messageTs = body.message?.ts || body.container?.message_ts;

  if (!pactId || !userId) return;

  const { snoozePactDueDate } = require('../db/pacts');
  const newDate = datePlusDays(3);
  const updated = await snoozePactDueDate(pactId, userId, newDate);

  if (!updated) {
    try {
      await client.chat.postEphemeral({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        user: userId,
        text: ':x: Only the promise-maker can snooze this pact.',
      });
    } catch {}
    return;
  }

  await sendSnoozeConfirmation(client, channelId, userId, pactId, newDate, messageTs);
  if (homeTab) homeTab.publishHomeTab(client, userId).catch(() => {});
}

/**
 * Handle "📅 Pick a Date" button — opens a modal with a native date picker.
 * WHY: Slack's date_picker element in actions doesn't submit without a form context;
 * a modal gives us a proper submit flow with ack and form data.
 */
async function handleSnoozePickDate({ ack, action, body, client }) {
  await ack();
  const pactId = parseInt(action.value, 10);
  if (!pactId || !body.trigger_id) return;

  // Default initial date = tomorrow
  const tomorrow = datePlusDays(1);

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'snooze_date_modal',
        private_metadata: JSON.stringify({
          pactId,
          channelId: body.channel?.id || body.container?.channel_id,
        }),
        title: { type: 'plain_text', text: 'Pick a New Date', emoji: true },
        submit: { type: 'plain_text', text: '📅 Reschedule', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Reschedule Pact #${pactId}*\nChoose the new due date. I'll remind you then.`,
            },
          },
          {
            type: 'input',
            block_id: 'snooze_date_block',
            label: { type: 'plain_text', text: 'New due date' },
            element: {
              type: 'datepicker',
              action_id: 'snooze_date_input',
              initial_date: tomorrow,
              placeholder: { type: 'plain_text', text: 'Select a date' },
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error('[snooze] Failed to open date picker modal:', err.message);
  }
}

/**
 * Modal submission for the date picker snooze flow.
 */
async function handleSnoozeDateModalSubmit({ ack, body, view, client }) {
  await ack();

  let meta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    return;
  }

  const { pactId, channelId } = meta;
  const userId = body.user?.id;
  const selectedDate = view.state?.values?.snooze_date_block?.snooze_date_input?.selected_date;

  if (!pactId || !userId || !selectedDate) return;

  const { snoozePactDueDate } = require('../db/pacts');
  const updated = await snoozePactDueDate(pactId, userId, selectedDate);

  if (!updated) {
    try {
      if (channelId) {
        await client.chat.postEphemeral({
          token: process.env.SLACK_BOT_TOKEN,
          channel: channelId,
          user: userId,
          text: ':x: Only the promise-maker can snooze this pact.',
        });
      }
    } catch {}
    return;
  }

  if (channelId) {
    await sendSnoozeConfirmation(client, channelId, userId, pactId, selectedDate, null);
  }
  if (homeTab) homeTab.publishHomeTab(client, userId).catch(() => {});
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Message Shortcut — "Make this a Pact"
// Registered as a message_action in the Slack app manifest with callback_id
// `make_this_a_pact`. Opens a modal pre-filled with the message text.
// ---------------------------------------------------------------------------

/**
 * Open the "Make this a Pact" modal when the user selects the shortcut from the
 * message context menu (⋮ → More actions → Make this a Pact).
 */
async function handleMessageShortcut({ shortcut, ack, client }) {
  await ack();

  const userId = shortcut.user.id;
  const teamId = shortcut.team?.id || shortcut.enterprise?.id || null;
  const messageText = shortcut.message?.text || '';
  const messageAuthor = shortcut.message?.user || null;
  const channelId = shortcut.channel?.id || null;
  const messageTs = shortcut.message?.ts || null;

  // Default: message author is the promiser, shortcut user is the recipient.
  // If the reactor IS the author (self-action), set both to the same person.
  const isSelfAction = messageAuthor && messageAuthor === userId;
  const promiserId = messageAuthor || userId;
  const recipientId = isSelfAction ? userId : userId;

  const pactData = JSON.stringify({
    messageText: messageText.substring(0, 500),
    channelId,
    messageTs,
    promiserId,
    recipientId,
    triggeredBy: userId,
    teamId,
    swapped: false,
  });

  try {
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildMessageShortcutModal({
        messageText,
        promiserId,
        recipientId,
        pactData,
        swapped: false,
      }),
    });
  } catch (err) {
    console.error(`[SHORTCUT] Failed to open modal: ${err.message}`);
  }
}

/**
 * Build the modal view blocks for "Make this a Pact" shortcut.
 */
function buildMessageShortcutModal({ messageText, promiserId, recipientId, pactData, swapped }) {
  const truncated = (messageText || '').substring(0, 300).trim() || '(message text unavailable)';

  return {
    type: 'modal',
    callback_id: 'shortcut_create_pact',
    title: { type: 'plain_text', text: 'Make this a Pact', emoji: true },
    submit: { type: 'plain_text', text: '✅ Create Pact', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: pactData,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:handshake: *Turn this message into a tracked commitment:*\n\n_"${truncated}"_`,
        },
      },
      {
        type: 'input',
        block_id: 'shortcut_description',
        label: { type: 'plain_text', text: 'Commitment (edit if needed)' },
        element: {
          type: 'plain_text_input',
          action_id: 'description_input',
          initial_value: messageText.substring(0, 500).trim(),
          placeholder: { type: 'plain_text', text: 'What are you committing to?' },
          multiline: false,
        },
      },
      {
        type: 'input',
        block_id: 'shortcut_due_date',
        optional: true,
        label: { type: 'plain_text', text: 'Due date (optional)' },
        element: {
          type: 'plain_text_input',
          action_id: 'due_date_input',
          placeholder: { type: 'plain_text', text: 'e.g. Friday 5pm, next Monday, 2026-05-15' },
          initial_value: '',
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Promiser (who commits):*\n<@${promiserId}>` },
          { type: 'mrkdwn', text: `*Recipient (who holds accountable):*\n<@${recipientId}>` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'shortcut_swap_parties',
            text: { type: 'plain_text', text: swapped ? '↩ Swap back' : '⇄ Swap roles', emoji: true },
            value: pactData,
          },
        ],
      },
    ],
  };
}

/**
 * Action: swap promiser ↔ recipient roles in the shortcut modal (updates the view in-place).
 */
async function handleShortcutSwapParties({ action, ack, body, client }) {
  await ack();

  let pactData;
  try {
    pactData = JSON.parse(action.value);
  } catch {
    return;
  }

  // Swap
  const { promiserId, recipientId } = pactData;
  pactData.promiserId = recipientId;
  pactData.recipientId = promiserId;
  pactData.swapped = !pactData.swapped;

  // Extract current description and due date from view state so they survive the swap
  const state = body.view?.state?.values || {};
  const currentDescription = state['shortcut_description']?.description_input?.value || pactData.messageText || '';
  const currentDueDate = state['shortcut_due_date']?.due_date_input?.value || '';

  const newView = buildMessageShortcutModal({
    messageText: pactData.messageText,
    promiserId: pactData.promiserId,
    recipientId: pactData.recipientId,
    pactData: JSON.stringify(pactData),
    swapped: pactData.swapped,
  });

  // Preserve user edits
  newView.blocks[1].element.initial_value = currentDescription.substring(0, 500);
  if (currentDueDate) {
    newView.blocks[2].element.initial_value = currentDueDate;
  }

  try {
    await client.views.update({
      view_id: body.view.id,
      view: newView,
    });
  } catch (err) {
    console.error(`[SHORTCUT] Failed to update modal: ${err.message}`);
  }
}

/**
 * Modal submission: user clicked "Create Pact" in the shortcut modal.
 */
async function handleShortcutModalSubmit({ ack, body, view, client }) {
  await ack();

  let pactData;
  try {
    pactData = JSON.parse(view.private_metadata);
  } catch {
    console.error('[SHORTCUT] Could not parse private_metadata');
    return;
  }

  const state = view.state?.values || {};
  const description = (state['shortcut_description']?.description_input?.value || pactData.messageText || '').substring(0, 500).trim();
  const dueDateRaw = state['shortcut_due_date']?.due_date_input?.value || '';

  let dueDate = null;
  if (dueDateRaw.trim()) {
    const parsed = parseDueDate(dueDateRaw.trim());
    dueDate = parsed.dueDate || null;
  }

  const { promiserId, recipientId, channelId, teamId } = pactData;
  const userId = body.user.id;
  const resolvedTeamId = teamId || body.team?.id;

  // Post to the channel the shortcut was triggered from, or open a DM with the triggering user
  let postChannelId = channelId;
  if (!postChannelId) {
    try {
      const dm = await client.conversations.open({ users: userId });
      postChannelId = dm.channel.id;
    } catch {
      console.error('[SHORTCUT] Could not open DM channel for shortcut submission');
      return;
    }
  }

  try {
    // Enforce monthly pact limits
    if (resolvedTeamId) {
      const teamTier = await getTeamTier(resolvedTeamId);
      const monthlyLimit = PLAN_MONTHLY_LIMITS[teamTier];
      if (monthlyLimit !== null) {
        const monthlyCount = await getMonthlyPactCount(resolvedTeamId);
        if (monthlyCount >= monthlyLimit) {
          const dm = await client.conversations.open({ users: userId });
          await client.chat.postMessage({
            channel: dm.channel.id,
            text: `:warning: Your workspace has hit the *${monthlyLimit} pacts/month* limit on the Free plan. Upgrade to Pro for unlimited pacts: <https://makepact.co/#pricing|makepact.co/#pricing>`,
          });
          return;
        }
      }
    }

    const isSolo = promiserId === recipientId;
    const [promiserName, promiserTz, recipientTz, recipientName] = await Promise.all([
      getUserName(client, promiserId),
      getUserTimezone(client, promiserId),
      isSolo ? Promise.resolve('America/New_York') : getUserTimezone(client, recipientId),
      isSolo ? Promise.resolve(null) : getUserName(client, recipientId),
    ]);

    const dueDateStr = dueDate ? formatDate(dueDate, promiserTz) : 'No due date set';
    const recipientDueDateStr = dueDate ? formatDate(dueDate, recipientTz) : 'No due date set';

    // Insert the pact
    const result = await pool.query(
      `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                          counterparty_slack_id, counterparty_name, description, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       RETURNING id`,
      [
        resolvedTeamId || null,
        postChannelId,
        promiserId,
        promiserName,
        isSolo ? null : recipientId,
        isSolo ? null : recipientName,
        description,
        dueDate,
      ]
    );
    const pactId = result.rows[0].id;

    // Mark first_pact_created if this is the promiser's first pact
    if (resolvedTeamId) {
      pool.query(
        `UPDATE installations SET first_pact_created = TRUE WHERE team_id = $1 AND first_pact_created = FALSE`,
        [resolvedTeamId]
      ).catch(() => {});
      // Quality signal for invite Pro grant
      require('../db/invites').markInvitePactCreated(resolvedTeamId).catch(() => {});
    }

    // First-pact celebration DM
    triggerFirstPactCelebration({
      creatorId: promiserId,
      teamId: resolvedTeamId || null,
      counterpartyName: isSolo ? null : recipientName,
    });

    // Sync to tracker (non-blocking)
    tracker.syncPact({
      pactId, teamId: resolvedTeamId, promiserId, promiserName,
      recipientId: isSolo ? null : recipientId, recipientName: isSolo ? null : recipientName,
      description, dueDate,
    }).catch(() => {});

    // Confirmation DM to promiser
    const confirmationText = `:handshake: *Pact created!*\n\n_${description}_\nDue: *${dueDateStr}*\n\nCounterparty: ${isSolo ? 'Solo pact' : `<@${recipientId}>`}\nID: \`${pactId}\` — type \`/done ${pactId}\` when complete.`;
    const promiserDm = await client.conversations.open({ users: promiserId });
    const confirmMsg = await client.chat.postMessage({
      channel: promiserDm.channel.id,
      text: confirmationText,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: confirmationText },
        },
      ],
    });

    // Store confirmation message for emoji-based completion
    if (confirmMsg?.ts) {
      await pool.query(
        `UPDATE pacts SET confirmation_channel = $1, confirmation_ts = $2 WHERE id = $3`,
        [promiserDm.channel.id, confirmMsg.ts, pactId]
      ).catch(() => {});
    }

    // Notify recipient (if not solo)
    if (!isSolo && recipientId !== promiserId) {
      try {
        const recipientDm = await client.conversations.open({ users: recipientId });
        await client.chat.postMessage({
          channel: recipientDm.channel.id,
          text: `${promiserName} made a pact with you: ${description} (due ${recipientDueDateStr})`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `:handshake: *${promiserName} made a pact with you!*`,
                  `_${description}_`,
                  `Due: *${recipientDueDateStr}*`,
                  '',
                  `I'll remind you both. Type \`/done ${pactId}\` when it's done.`,
                ].join('\n'),
              },
            },
          ],
        });
      } catch (notifyErr) {
        console.error(`[SHORTCUT] Could not notify recipient ${recipientId}: ${notifyErr.message}`);
      }
    }

    console.log(`[SHORTCUT] Pact #${pactId} created by ${userId} for ${promiserId} → ${recipientId}`);
  } catch (err) {
    console.error(`[SHORTCUT] Error creating pact: ${err.message}`);
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({ channel: dm.channel.id, text: ':x: Failed to create the pact. Please try again.' });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// AI Commitment Detection — Channel Message Processing
// ---------------------------------------------------------------------------

/**
 * Analyze a channel message for commitment language and, for Pro workspaces,
 * send an ephemeral "Make it a pact?" prompt to the sender if a commitment is detected.
 *
 * Guards: Pro-only · not DMs · not bot messages · rate-limited (1/user/hr) · channel-snooze respected
 *
 * @param {Object} message - Bolt message payload
 * @param {Object} client  - Slack Web API client
 */
async function handleChannelMessageForCommitment(message, client) {
  if (!aiCommitment) return;

  const teamId = message.team;
  const userId = message.user;
  const channelId = message.channel;
  const text = message.text || '';

  // Pro-only feature
  const tier = await getTeamTier(teamId);
  if (tier !== 'pro') return;

  // Quick regex pre-filter — avoids an AI call for obvious non-commitments
  if (!aiCommitment.looksLikeCommitment(text)) return;

  // Channel snooze check
  if (await aiCommitment.isChannelSnoozed(pool, teamId, channelId)) return;

  // Rate limit — at most one suggestion per user per hour
  if (!(await aiCommitment.canSuggestToUser(pool, teamId, userId))) return;

  // Fetch channel members for recipient identification (best-effort)
  let channelMembers = [];
  try {
    const members = await client.conversations.members({ channel: channelId, limit: 50 });
    const memberIds = (members.members || []).filter(id => id !== userId && id !== botUserId);
    // Get display names for the top members so AI can match them
    const nameResults = await Promise.allSettled(
      memberIds.slice(0, 10).map(id => getUserName(client, id).then(name => ({ id, name })))
    );
    channelMembers = nameResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
  } catch { /* non-fatal — AI will still detect, just can't name recipient */ }

  // AI detection
  const commitment = await aiCommitment.detectCommitment(text, { userId, channelMembers });
  if (!commitment) return;

  // Record before posting so a crash on postEphemeral doesn't let us spam
  await aiCommitment.recordSuggestion(pool, teamId, userId);

  // Send ephemeral suggestion to the promiser only
  const suggestion = aiCommitment.buildSuggestionBlocks({
    description: commitment.description,
    possibleDueDate: commitment.possibleDueDate,
    promiserId: commitment.promiserId || userId,
    recipientId: commitment.recipientId,
    channelId,
    messageTs: message.ts,
    teamId,
  });

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: suggestion.text,
    blocks: suggestion.blocks,
  });
}

/**
 * User tapped "✅ Create Pact" on the AI commitment suggestion.
 * Open the pre-filled "Make this a Pact" modal (reuses handleMessageShortcut flow).
 *
 * @param {Object} action - Bolt action payload
 * @param {Object} body   - full Bolt body
 * @param {Object} client - Slack Web API client
 */
async function handleSuggestPactConfirm(action, body, client) {
  let payload;
  try {
    payload = JSON.parse(action.value);
  } catch {
    console.error('[commit-detect] Could not parse suggest_pact_confirm payload');
    return;
  }

  const { description, possibleDueDate, promiserId, recipientId, channelId, messageTs, teamId } = payload;
  const userId = body.user?.id || promiserId;

  // Build the pre-filled modal (same structure as the message shortcut modal)
  const pactData = JSON.stringify({
    messageText: description,
    channelId,
    messageTs,
    promiserId: promiserId || userId,
    recipientId: recipientId || userId,
    triggeredBy: userId,
    teamId,
    swapped: false,
  });

  const view = buildMessageShortcutModal({
    messageText: description,
    promiserId: promiserId || userId,
    recipientId: recipientId || userId,
    pactData,
    swapped: false,
  });

  // Pre-fill the due date field if the AI extracted one
  if (possibleDueDate) {
    // Block index 2 is the due date input
    if (view.blocks[2]?.element) {
      view.blocks[2].element.initial_value = possibleDueDate;
    }
  }

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view,
    });
  } catch (err) {
    console.error('[commit-detect] Failed to open modal:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Recurrence helpers
// ---------------------------------------------------------------------------

/**
 * Parse `--repeat <rule>` flag from pact text and return { description, dueDate, recurrenceRule }.
 * Strips the `--repeat` flag before passing the remainder to parseDueDate.
 *
 * Accepted formats:
 *   --repeat daily
 *   --repeat weekly[:monday|:tue|:2]  (day name or 0-6, default Monday)
 *   --repeat biweekly[:friday]
 *   --repeat monthly[:15]             (day-of-month, default 1)
 */
function parseTextWithRecurrence(rawText) {
  const repeatRe = /--repeat\s+(\S+)/i;
  const match = rawText.match(repeatRe);

  if (!match) {
    // No repeat flag — fall through to normal parsing
    const parsed = parseDueDate(rawText);
    return { description: parsed.description, dueDate: parsed.dueDate, recurrenceRule: null };
  }

  const ruleStr = match[1].toLowerCase();
  const cleanedText = rawText.replace(repeatRe, '').replace(/\s+/g, ' ').trim();
  const parsed = parseDueDate(cleanedText);

  let rule = null;
  if (ruleStr === 'daily') {
    rule = { frequency: 'daily' };
  } else if (ruleStr.startsWith('weekly')) {
    const dayStr = ruleStr.split(':')[1];
    rule = { frequency: 'weekly', day: parseDayArg(dayStr, 1) }; // default Monday
  } else if (ruleStr.startsWith('biweekly')) {
    const dayStr = ruleStr.split(':')[1];
    rule = { frequency: 'biweekly', day: parseDayArg(dayStr, 1) };
  } else if (ruleStr.startsWith('monthly')) {
    const domStr = ruleStr.split(':')[1];
    const dom = domStr ? parseInt(domStr, 10) : 1;
    rule = { frequency: 'monthly', dayOfMonth: (isNaN(dom) || dom < 1 || dom > 31) ? 1 : dom };
  }

  return { description: parsed.description, dueDate: parsed.dueDate, recurrenceRule: rule };
}

const DAY_NAME_MAP = { sun:0, sunday:0, mon:1, monday:1, tue:2, tuesday:2, wed:3, wednesday:3,
  thu:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };

function parseDayArg(dayStr, defaultDay) {
  if (!dayStr) return defaultDay;
  const n = parseInt(dayStr, 10);
  if (!isNaN(n) && n >= 0 && n <= 6) return n;
  return DAY_NAME_MAP[dayStr.toLowerCase()] ?? defaultDay;
}

/**
 * Build the "Create a Pact" modal view with an optional Repeats dropdown.
 * private_metadata carries channelId, teamId, userId, cpId.
 */
function buildCreatePactModal({ pactData }) {
  return {
    type: 'modal',
    callback_id: 'create_pact_modal',
    title: { type: 'plain_text', text: 'New Pact', emoji: true },
    submit: { type: 'plain_text', text: '✅ Create Pact', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: pactData,
    blocks: [
      {
        type: 'input',
        block_id: 'pact_description',
        label: { type: 'plain_text', text: 'What are you committing to?' },
        element: {
          type: 'plain_text_input',
          action_id: 'description_input',
          placeholder: { type: 'plain_text', text: 'e.g. Review the design doc' },
        },
      },
      {
        type: 'input',
        block_id: 'pact_due_date',
        label: { type: 'plain_text', text: 'Due date' },
        element: {
          type: 'plain_text_input',
          action_id: 'due_date_input',
          placeholder: { type: 'plain_text', text: 'e.g. Friday 5pm, next Monday, 2026-05-20' },
        },
      },
      {
        type: 'input',
        block_id: 'pact_repeats',
        optional: true,
        label: { type: 'plain_text', text: 'Repeats (optional)' },
        element: {
          type: 'static_select',
          action_id: 'repeats_input',
          placeholder: { type: 'plain_text', text: 'Does not repeat' },
          options: [
            { text: { type: 'plain_text', text: 'Does not repeat' }, value: 'none' },
            { text: { type: 'plain_text', text: 'Daily' }, value: 'daily' },
            { text: { type: 'plain_text', text: 'Every Monday' }, value: 'weekly:1' },
            { text: { type: 'plain_text', text: 'Every Tuesday' }, value: 'weekly:2' },
            { text: { type: 'plain_text', text: 'Every Wednesday' }, value: 'weekly:3' },
            { text: { type: 'plain_text', text: 'Every Thursday' }, value: 'weekly:4' },
            { text: { type: 'plain_text', text: 'Every Friday' }, value: 'weekly:5' },
            { text: { type: 'plain_text', text: 'Biweekly (Friday)' }, value: 'biweekly:5' },
            { text: { type: 'plain_text', text: 'Monthly (1st)' }, value: 'monthly:1' },
            { text: { type: 'plain_text', text: 'Monthly (15th)' }, value: 'monthly:15' },
          ],
        },
      },
    ],
  };
}

/**
 * Parse a "repeats" select option value like 'weekly:5' into a recurrence rule object.
 */
function parseRepeatOption(optionValue) {
  if (!optionValue || optionValue === 'none') return null;
  const [freq, param] = optionValue.split(':');
  const p = param !== undefined ? parseInt(param, 10) : undefined;
  switch (freq) {
    case 'daily':    return { frequency: 'daily' };
    case 'weekly':   return { frequency: 'weekly', day: isNaN(p) ? 1 : p };
    case 'biweekly': return { frequency: 'biweekly', day: isNaN(p) ? 5 : p };
    case 'monthly':  return { frequency: 'monthly', dayOfMonth: isNaN(p) ? 1 : p };
    default:         return null;
  }
}

/**
 * Handle modal submission from the "New Pact" modal (create_pact_modal).
 */
async function handleCreatePactModalSubmit({ ack, body, view, client }) {
  await ack();

  let meta;
  try {
    meta = JSON.parse(view.private_metadata);
  } catch {
    console.error('[create-pact-modal] Could not parse private_metadata');
    return;
  }

  const { channelId, teamId, userId, cpId } = meta;
  const state = view.state?.values || {};
  const description = (state['pact_description']?.description_input?.value || '').trim();
  const dueDateRaw   = (state['pact_due_date']?.due_date_input?.value || '').trim();
  const repeatOption = state['pact_repeats']?.repeats_input?.selected_option?.value || null;

  if (!description) return;

  let dueDate = null;
  if (dueDateRaw) {
    const parsed = parseDueDate(dueDateRaw);
    dueDate = parsed.dueDate || null;
  }

  const recurrenceRule = parseRepeatOption(repeatOption);
  const recurrenceGroupId = recurrenceRule ? randomUUID() : null;

  // Enforce plan limits
  const teamTier = await getTeamTier(teamId);
  const monthlyLimit = PLAN_MONTHLY_LIMITS[teamTier];
  if (monthlyLimit !== null) {
    const monthlyCount = await getMonthlyPactCount(teamId);
    if (monthlyCount >= monthlyLimit) {
      try {
        await client.chat.postEphemeral({
          channel: channelId, user: userId,
          text: `:warning: Your workspace has reached the *${monthlyLimit} active pacts/month* limit. Upgrade to Pro at makepact.co/#pricing.`,
        });
      } catch {}
      return;
    }
  }

  // Resolve names
  const [creatorName, cpName] = await Promise.all([
    getUserName(client, userId),
    cpId ? getUserName(client, cpId) : Promise.resolve(null),
  ]);

  const result = await pool.query(
    `INSERT INTO pacts (team_id, channel_id, creator_slack_id, creator_name,
                        counterparty_slack_id, counterparty_name, description, due_date, status,
                        recurrence_rule, recurrence_group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10)
     RETURNING id`,
    [teamId, channelId, userId, creatorName, cpId, cpName, description, dueDate,
     recurrenceRule ? JSON.stringify(recurrenceRule) : null, recurrenceGroupId]
  );

  const pactId = result.rows[0].id;

  // Activation funnel: mark pact creation if this modal was opened from the activation DM
  if (meta.fromActivation && activationDm) {
    activationDm.onActivationPactCreated(teamId, userId).catch((err) =>
      console.error('[activation] onActivationPactCreated error:', err.message)
    );
  }

  // First-pact celebration DM — fires if this is the creator's 0 → 1 transition
  triggerFirstPactCelebration({ creatorId: userId, teamId, counterpartyName: cpName });

  // Quality signal for invite Pro grant
  if (teamId) require('../db/invites').markInvitePactCreated(teamId).catch(() => {});

  // Tracker sync — non-blocking
  tracker.syncPactToTracker(pool, { id: pactId, description, due_date: dueDate, team_id: teamId,
    creator_name: creatorName, counterparty_name: cpName }, teamId, { creatorSlackId: userId });

  // Refresh home tab
  if (homeTab) {
    homeTab.publishHomeTab(client, userId).catch(() => {});
    if (cpId) homeTab.publishHomeTab(client, cpId).catch(() => {});
  }

  const creatorTz = await getUserTimezone(client, userId);
  const dueDateStr = dueDate ? formatDate(dueDate, creatorTz) : 'no deadline';
  const recurLine = recurrenceRule ? `\n🔄 *Repeats:* ${recurrenceLabel(recurrenceRule)}` : '';
  const reminderText = cpId ? `Both <@${userId}> and <@${cpId}> will be reminded` : `You'll be reminded`;

  const commitBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:handshake: *<@${userId}> committed to:*\n\n*${description}*\nDue: *${dueDateStr}*${recurLine}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${reminderText} · Type \`/done\` to mark complete` }],
    },
  ];

  try {
    await client.chat.postMessage({
      channel: channelId,
      blocks: commitBlocks,
      text: `Pact #${pactId}: ${creatorName} committed to: ${description} — due ${dueDateStr}`,
    });
  } catch (err) {
    console.error('[create-pact-modal] Failed to post confirmation:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Home Tab Quick Actions handlers
// ---------------------------------------------------------------------------

async function handleHomeStats({ ack, body, respond }) {
  await ack();
  const userId = body.user?.id;
  const teamId = body.user?.team_id || body.team?.id;
  if (!userId) return;

  const tz = await getUserTimezone(userId);
  const [stats, currentStreak, bestStreak] = await Promise.all([
    pactsDb.getUserPactStats(userId),
    pactsDb.getPromiseStreak(userId, tz),
    pactsDb.getBestStreak(userId),
  ]);

  const { totalCreated, totalCompleted, totalActive, overdueCount, completionRate } = stats;
  const pctColor = completionRate >= 80 ? 'good' : completionRate >= 50 ? 'warning' : 'danger';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📊 Your Pact Stats', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Pacts Created*\n' + totalCreated },
        { type: 'mrkdwn', text: '*Completed*\n' + totalCompleted + '  (`' + completionRate + '%` rate)' },
        { type: 'mrkdwn', text: '*Active*\n' + totalActive },
        { type: 'mrkdwn', text: '*Overdue*\n' + overdueCount },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Current Streak*\n:fire: ' + currentStreak + ' day' + (currentStreak !== 1 ? 's' : '') },
        { type: 'mrkdwn', text: '*Best Streak*\n:trophy: ' + bestStreak + ' day' + (bestStreak !== 1 ? 's' : '') },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_Stats reflect pacts you created. Completion rate = completed / (completed + cancelled)._' },
      ],
    },
  ];

  await respond({
    response_type: 'ephemeral',
    replace_original: false,
    blocks,
    text: `Your Pact Stats — ${totalCreated} created, ${totalCompleted} completed, ${currentStreak}-day streak`,
  });
}

async function handleHomeHelp({ ack, body, respond }) {
  await ack();
  const teamId = body.user?.team_id || body.team?.id;
  const helpTier = teamId ? await getTeamTier(teamId) : 'free';
  const badge = planBadge(helpTier);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🤝 Pact Commands', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*Create a pact*',
          '`/pact Review the design doc by Friday`',
          '',
          '*Mark complete*',
          '`/done` — or react 🤝 to a reminder',
          '',
          '*Manage your pacts*',
          '`/pacts` — list all active pacts',
          '',
          '*Track your stats*',
          '`/pact stats` — your accountability metrics',
          '',
          '*Streak & sharing*',
          '`/pact share` — share your streak card',
          '',
          '*Settings*',
          '`/pact digest` — weekly standup digest',
          '`/pact settings` — tracker integrations',
        ].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: badge + (helpTier === 'pro' ? ' — unlimited pacts + integrations' : ' — up to 100 pacts/mo · /pact upgrade for Pro') },
      ],
    },
  ];

  await respond({
    response_type: 'ephemeral',
    replace_original: false,
    blocks,
    text: 'Pact Commands — /pact, /pacts, /done, /pact stats, /pact share, /pact digest, /pact settings',
  });
}

// ---------------------------------------------------------------------------
// Slack App Handler Registration
// Called from start() to wire all commands/actions/events onto a Bolt App instance
// ---------------------------------------------------------------------------
function serverlessSlashCommand(handler) {
  return async (args) => {
    const originalAck = args.ack;
    const originalRespond = args.respond;
    let acknowledged = false;
    let emptyAckRequested = false;

    // Vercel may freeze a serverless invocation as soon as an empty ack ends
    // the HTTP request. Delay that empty ack so the handler's first visible
    // response can be returned inline to Slack instead.
    const ack = async (payload) => {
      if (acknowledged) return;
      if (payload === undefined) {
        emptyAckRequested = true;
        return;
      }
      acknowledged = true;
      return originalAck(payload);
    };

    const respond = async (payload) => {
      if (!acknowledged) {
        acknowledged = true;
        return originalAck(payload);
      }
      return originalRespond(payload);
    };

    try {
      await handler({ ...args, ack, respond });
    } catch (err) {
      if (!acknowledged) {
        acknowledged = true;
        await originalAck({
          response_type: 'ephemeral',
          text: 'Something went wrong while handling that command. Please try again.',
        });
      }
      throw err;
    } finally {
      if (!acknowledged && emptyAckRequested) {
        acknowledged = true;
        await originalAck();
      }
    }
  };
}

function registerSlackHandlers(slackApp) {
  slackApp.command('/pact', serverlessSlashCommand(handleCreatePact));
  slackApp.command('/pacts', serverlessSlashCommand(handleListPacts));
  slackApp.command('/done', serverlessSlashCommand((args) => doneRoutes.handleDoneCommand(args, tracker)));
  slackApp.action('select_pact_complete', (args) => doneRoutes.handleSelectPactComplete(args, tracker));
  slackApp.action('multi_pact_complete_confirm', (args) => doneRoutes.handleMultiCompleteConfirm(args, tracker));
  slackApp.action('multi_pact_complete_all', (args) => doneRoutes.handleMultiCompleteAll(args, tracker));
  slackApp.action('multi_pact_complete_select', async ({ ack }) => { await ack(); });

  // AI-powered /done suggestion actions (Pro tier)
  slackApp.action('ai_done_confirm', (args) => doneRoutes.handleAIDoneConfirm(args, tracker));
  slackApp.action('ai_done_show_all', (args) => doneRoutes.handleAIDoneShowAll(args));

  // Tracker disconnect actions
  for (const provider of ['linear', 'asana', 'notion']) {
    slackApp.action('tracker_disconnect_' + provider, async ({ action, ack, body, respond }) => {
      await ack();
      const teamId = body.team?.id || body.user?.team_id;
      if (!teamId) return;
      await tracker.disconnectTracker(pool, teamId, provider);
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text: ':white_check_mark: ' + provider.charAt(0).toUpperCase() + provider.slice(1) + ' disconnected.'
      });
    });
  }

  // Tracker "upgrade" button (no-op ack)
  slackApp.action('tracker_upgrade_pro', async ({ ack }) => { await ack(); });

  // Weekly standup digest action handlers
  slackApp.action('digest_complete_pact', (args) => digestRoutes.handleDigestComplete(args, tracker));
  slackApp.action('digest_snooze', (args) => digestRoutes.handleDigestSnooze(args));
  slackApp.action('digest_opt_out', (args) => digestRoutes.handleDigestOptOut(args));
  slackApp.action('digest_settings_enable', (args) => digestRoutes.handleDigestSettingsEnable(args));

  // Billing upgrade buttons (just ack — browser opens the URL automatically)
  slackApp.action('upgrade_to_pro', async ({ ack }) => { await ack(); });

  // Tracker connect URL buttons (just ack — browser opens the URL automatically)
  for (const provider of ['linear', 'asana', 'notion']) {
    slackApp.action('tracker_connect_' + provider, async ({ ack }) => { await ack(); });
  }

  // Reminder thread — "✅ Mark Complete" button
  slackApp.action('complete_from_reminder', handleCompleteFromReminder);

  // Reminder thread — snooze / reschedule buttons
  slackApp.action('snooze_tomorrow', handleSnoozeTomorrow);
  slackApp.action('snooze_3days', handleSnooze3Days);
  slackApp.action('snooze_pick_date', handleSnoozePickDate);
  slackApp.view('snooze_date_modal', handleSnoozeDateModalSubmit);

  // ── Counterparty-initiated reschedule proposals ──────────────────────────
  // "Propose new date" button (counterparty nudge DM + Home Tab "owed to me" rows)
  slackApp.action('propose_reschedule', (args) => rescheduleProposals.handleProposeReschedule(args));
  slackApp.view('reschedule_proposal_modal', (args) => rescheduleProposals.handleRescheduleProposalSubmit(args));
  // Creator response buttons (Accept / Decline / Counter-propose)
  slackApp.action('reschedule_accept', (args) => rescheduleProposals.handleRescheduleAccept(args));
  slackApp.action('reschedule_decline', (args) => rescheduleProposals.handleRescheduleDecline(args));
  slackApp.action('reschedule_counter', (args) => rescheduleProposals.handleRescheduleCounter(args));
  slackApp.view('reschedule_counter_modal', (args) => rescheduleProposals.handleRescheduleCounterSubmit(args));
  // Ack-only: counterparty nudge home link button (URL button — Slack fires action anyway)
  slackApp.action('counterparty_nudge_home_link', async ({ ack }) => { await ack(); });

  // New Pact modal (opened when /pact is typed with no text in a DM)
  slackApp.view('create_pact_modal', handleCreatePactModalSubmit);

  // Conversational DM — listen for direct messages to the bot
  slackApp.message(async ({ message, client }) => {
    // Only respond in DMs (im = direct message channel)
    if (message.channel_type !== 'im') return;

    // Prioritize thread replies on reminder messages (zero-friction completion)
    // Returns true if handled — skip normal DM intent detection in that case.
    if (message.thread_ts && message.thread_ts !== message.ts) {
      try {
        const handled = await handleReminderThreadReply(message, client);
        if (handled) return;
      } catch (err) {
        console.error('[reminder-thread] Error handling thread reply:', err.message);
      }
    }

    await handleDMMessage(message, client);
  });

  // DM action handlers
  slackApp.action('dm_confirm_pact', handleDMConfirmPact);
  slackApp.action('dm_cancel_pact', handleDMCancelPact);
  slackApp.action('dm_select_pact_complete', (args) => doneRoutes.handleSelectPactComplete(args, tracker));

  // Peer DM pact proposal handlers (for 2-person DMs where bot can't read members)
  slackApp.action('accept_dm_pact', handleAcceptDmPact);
  slackApp.action('decline_dm_pact', handleDeclineDmPact);

  // Pact edit / extend pickers (from /pact edit and /pact extend commands)
  slackApp.action('select_pact_edit', handleSelectPactEdit);
  slackApp.action('select_pact_extend', handleSelectPactExtend);

  // Emoji-reaction -> pact flow
  slackApp.event('reaction_added', handleReactionAdded);
  slackApp.action('reaction_confirm_pact', handleReactionConfirmPact);
  slackApp.action('reaction_swap_parties', handleReactionSwapParties);
  slackApp.action('reaction_cancel_pact', handleReactionCancelPact);

  // Message shortcut — "Make this a Pact" (⋮ → More actions → Make this a Pact)
  slackApp.shortcut('make_this_a_pact', handleMessageShortcut);
  slackApp.action('shortcut_swap_parties', handleShortcutSwapParties);
  slackApp.view('shortcut_create_pact', handleShortcutModalSubmit);

  // ── App Home Tab ──────────────────────────────────────────────────────────
  // Render a promises dashboard when the user opens the app in the sidebar.
  // Also triggers the immediate welcome DM for first-time installers with zero pacts.
  slackApp.event('app_home_opened', async ({ event, body, client }) => {
    // tab === 'home' distinguishes app home from messages tab
    if (event.tab !== 'home') return;
    if (!homeTab) return;

    // WHY body.team_id: Bolt provides team context via body; event.team_id is not reliable.
    // Hoisted here so it's available both for the welcome DM trigger and the home tab render.
    const eventTeamId = body?.team_id || body?.team?.id || null;

    // Trigger welcome DM — immediate onboarding before the 24h activation nudge
    // Only fires for the installer user, once per installation.
    if (welcomeDm) {
      const userId = event.user;
      // Look up this team's installer and bot_token, scoped to the event's team
      let installQuery, installParams;
      if (eventTeamId) {
        installQuery = `SELECT team_id, installer_user_id, bot_token FROM installations WHERE team_id = $1 ORDER BY updated_at DESC LIMIT 1`;
        installParams = [eventTeamId];
      } else {
        installQuery = `SELECT team_id, installer_user_id, bot_token FROM installations ORDER BY updated_at DESC LIMIT 1`;
        installParams = [];
      }
      const { rows } = await pool.query(installQuery, installParams);
      const install = rows[0];
      if (install && install.installer_user_id === userId && install.bot_token) {
        welcomeDm.sendWelcomeDm({
          botToken: install.bot_token,
          userId,
          teamId: install.team_id,
        }).catch(err => {
          console.error('[WELCOME] sendWelcomeDm error:', err.message);
          if (trackError) trackError(err.message, { tag: 'welcome-dm-trigger' });
        });
      }
    }

    // Pass eventTeamId so buildHomeView can show the Getting Started card for
    // zero-pact users (who have no pacts to derive teamId from otherwise).
    await homeTab.publishHomeTab(client, event.user, { teamId: eventTeamId });
  });

  // "✅ Complete" button on the home tab — complete pact inline and refresh
  slackApp.action('complete_from_home', async ({ action, ack, body, client }) => {
    await ack();
    const userId = body.user?.id;
    const pactId = parseInt(action.value, 10);
    if (!userId || isNaN(pactId)) return;
    // completePact handles the success/error message to the pact's original channel;
    // home tab refresh is triggered inside completePact after DB update succeeds.
    await completePact(pactId, userId, null, client);
    // Always re-publish home tab so the completed item disappears immediately
    // bustCache=true so streak/stats reflect the completion right away
    if (homeTab) homeTab.publishHomeTab(client, userId, { bustCache: true }).catch(() => {});
  });

  // "🚀 Make your first pact" button on Getting Started card in App Home
  slackApp.action('home_getting_started_pact', (args) => {
    if (!welcomeDm) return;
    welcomeDm.handleWelcomeMakePact(args);
  });

  // Quick Actions buttons in App Home
  slackApp.action('home_stats', handleHomeStats);
  slackApp.action('home_help', handleHomeHelp);
  slackApp.action('home_make_pact', async (args) => {
    const { ack, body } = args;
    await ack();
    // Open create-pact modal (same trigger_id logic as empty /pact)
    if (!body?.trigger_id) return;
    try {
      const client = args.client || args.context?.client;
      if (!client) return;
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCreatePactModal({ pactData: JSON.stringify({ channelId: null, teamId: body.team?.id, userId: body.user?.id, cpId: null }) }),
      });
    } catch (e) { /* modal trigger expired — silently ignore */ }
  });

  // Viral invite: "Get my invite link" → opens modal with copy-able link
  slackApp.action('home_invite_get_link', async ({ ack, body, client }) => {
    await ack();
    let userId, teamId;
    try {
      const parsed = JSON.parse(body.actions?.[0]?.value || '{}');
      userId = parsed.userId || body.user?.id;
      teamId = parsed.teamId || body.user?.team_id || body.team?.id;
    } catch {
      userId = body.user?.id;
      teamId = body.user?.team_id || body.team?.id;
    }
    if (!userId || !teamId) return;

    const { createInvite } = require('../db/invites');
    const invite = await createInvite({ inviterUserId: userId, inviterTeamId: teamId });
    const link = invite.invite_link;
    const copyText = `just got an invite to Pact — tracking commitments in Slack with automatic reminders. try it: ${link}`;
    const shareText = encodeURIComponent(copyText);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Your Invite Link' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Share this link to bring another team onto Pact.*\n\nWhen someone installs Pact through your link, they become your cross-workspace pact partner — accountability without the org chart.'
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Your invite link:*\n<${link}|${link}>` },
            accessory: {
              type: 'button',
              action_id: 'invite_copy_link',
              text: { type: 'plain_text', text: 'Copy link', emoji: true },
              value: link,
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '_Paste this into Slack, email, or wherever:_',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> ${copyText}`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                url: `https://twitter.com/intent/tweet?text=${shareText}`,
                text: { type: 'plain_text', text: 'Share on Twitter', emoji: true },
                value: 'twitter',
              },
              {
                type: 'button',
                action_id: 'invite_generate_new',
                text: { type: 'plain_text', text: '🔄 Generate new link', emoji: true },
                value: JSON.stringify({ userId, teamId }),
              },
            ],
          },
        ],
      },
    });
  });

  // Re-generate invite link from within the modal
  slackApp.action('invite_generate_new', async ({ ack, body, client }) => {
    await ack();
    let userId, teamId;
    try {
      const parsed = JSON.parse(body.actions?.[0]?.value || '{}');
      userId = parsed.userId || body.user?.id;
      teamId = parsed.teamId || body.user?.team_id || body.team?.id;
    } catch {
      return;
    }
    if (!userId || !teamId) return;

    const { createInvite } = require('../db/invites');
    const invite = await createInvite({ inviterUserId: userId, inviterTeamId: teamId });
    const link = invite.invite_link;
    const copyText = `just got an invite to Pact — tracking commitments in Slack with automatic reminders. try it: ${link}`;
    const shareText = encodeURIComponent(copyText);

    await client.views.update({
      view_id: body.view?.id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Your Invite Link' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Share this link to bring another team onto Pact.*\n\nWhen someone installs Pact through your link, they become your cross-workspace pact partner.'
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Your invite link:*\n<${link}|${link}>` },
            accessory: {
              type: 'button',
              action_id: 'invite_copy_link',
              text: { type: 'plain_text', text: 'Copy link', emoji: true },
              value: link,
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '_Paste this into Slack, email, or wherever:_' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> ${copyText}`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                url: `https://twitter.com/intent/tweet?text=${shareText}`,
                text: { type: 'plain_text', text: 'Share on Twitter', emoji: true },
                value: 'twitter',
              },
              {
                type: 'button',
                action_id: 'invite_generate_new',
                text: { type: 'plain_text', text: '🔄 Generate new link', emoji: true },
                value: JSON.stringify({ userId, teamId }),
              },
            ],
          },
        ],
      },
    });
  });

  // Copy link — send ephemeral confirmation
  slackApp.action('invite_copy_link', async ({ ack, body, client }) => {
    await ack();
    const link = body.actions?.[0]?.value;
    if (!link || !body.channel?.id || !body.message?.ts) return;
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: `Invite link copied to clipboard: ${link}`,
    });
  });

  // ── Bulk actions (Home Tab checkboxes + action bar) ───────────────────────
  // Checkbox toggle — just ack; actual processing happens when an action button is pressed
  slackApp.action('bulk_checkbox_change', (args) => bulkActions.handleBulkCheckboxChange(args));
  // Bulk complete selected
  slackApp.action('bulk_complete', (args) => bulkActions.handleBulkComplete(args));
  // Bulk snooze — ⏭ Tomorrow, ⏩ +3 Days, 📅 Pick date
  slackApp.action('bulk_snooze_tomorrow', (args) => bulkActions.handleBulkSnoozeTomorrow(args));
  slackApp.action('bulk_snooze_3days', (args) => bulkActions.handleBulkSnooze3Days(args));
  slackApp.action('bulk_snooze_pick_date', (args) => bulkActions.handleBulkSnoozePickDate(args));
  slackApp.view('bulk_snooze_date_modal', (args) => bulkActions.handleBulkSnoozeDateModalSubmit(args));
  // "Select all overdue" quick-action button
  slackApp.action('select_all_overdue', (args) => bulkActions.handleSelectAllOverdue(args));

  // ── AI Commitment Detection ───────────────────────────────────────────────
  // Listen for messages in public/private channels (not DMs). For Pro workspaces,
  // detect commitment language and send an ephemeral "Make it a pact?" prompt.
  // Never fires in DMs (too intrusive). Rate-limited to 1 suggestion/user/hour.
  slackApp.message(async ({ message, client }) => {
    // Only handle regular user messages in non-DM channels
    if (!message || message.subtype) return;                  // ignore edits, joins, etc.
    if (message.channel_type === 'im') return;                // skip DMs (handled elsewhere)
    if (message.bot_id) return;                               // skip bot messages
    if (!message.text || !message.user || !message.team) return;

    // Fire-and-forget — don't block Bolt's message pipeline
    handleChannelMessageForCommitment(message, client).catch((err) => {
      console.error('[commit-detect] Unhandled error:', err.message);
    });
  });

  // "✅ Create Pact" — user tapped confirm on the AI suggestion → open pre-filled modal
  slackApp.action('suggest_pact_confirm', async ({ action, ack, body, client }) => {
    await ack();
    await handleSuggestPactConfirm(action, body, client);
  });

  // "Dismiss" — user dismissed the suggestion (just delete the ephemeral)
  slackApp.action('suggest_pact_dismiss', async ({ action, ack, respond }) => {
    await ack();
    await respond({ delete_original: true });
  });

  // "Don't suggest in this channel" — snooze the channel and delete ephemeral
  slackApp.action('suggest_pact_snooze_channel', async ({ action, ack, respond }) => {
    await ack();
    try {
      const payload = JSON.parse(action.value);
      if (payload.channelId && payload.teamId && aiCommitment) {
        await aiCommitment.snoozeChannel(pool, payload.teamId, payload.channelId);
      }
    } catch { /* non-fatal */ }
    await respond({
      delete_original: true,
      // Slack ephemeral replacement to confirm the snooze
    });
  });

  // ── Streak milestone share buttons ───────────────────────────────────────
  // Twitter / LinkedIn share buttons just need an ack — the URL opens in the browser.
  // The analytics POST happens via the web page JS directly; Slack fires the action
  // because we declared action_id even on URL buttons. Just ack.
  slackApp.action('streak_share_twitter', async ({ ack }) => { await ack(); });
  slackApp.action('streak_share_linkedin', async ({ ack }) => { await ack(); });
  slackApp.action('streak_share_twitter_cmd', async ({ ack }) => { await ack(); });
  slackApp.action('streak_share_linkedin_cmd', async ({ ack }) => { await ack(); });

  // "Copy link" button — ack + send ephemeral confirmation with the card URL
  slackApp.action('streak_copy_link', async ({ action, ack, respond }) => {
    await ack();
    const cardUrl = action.value || '';
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: `🔗 Link copied! Share it anywhere: ${cardUrl}`,
    }).catch(() => {});
  });

  slackApp.action('streak_copy_link_cmd', async ({ action, ack, respond }) => {
    await ack();
    const cardUrl = action.value || '';
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: `🔗 Your streak card: ${cardUrl}`,
    }).catch(() => {});
  });

  // "Share streak" button on Home Tab streak section — generate card + respond with share DM
  slackApp.action('streak_share_home', async ({ action, ack, body, client }) => {
    await ack();
    const userId = body.user?.id;
    const teamId = body.user?.team_id || body.team?.id;
    if (!userId || !streakMilestones) return;

    try {
      const result = await streakMilestones.getOrCreateShareCard({ userId, teamId });
      if (!result) return; // no streak, nothing to share

      const { text: fallback, blocks } = streakMilestones.buildShareCommandBlocks(result);
      // Open DM with user to deliver the share card
      const dmResult = await client.conversations.open({ users: userId });
      const dmChannel = dmResult.channel?.id;
      if (dmChannel) {
        await client.chat.postMessage({ channel: dmChannel, text: fallback, blocks });
      }
    } catch (err) {
      console.error(`[STREAK] streak_share_home error user=${userId}: ${err.message}`);
    }
  });

  // ── Activation DM (24h partner invite) ────────────────────────────────────
  activationDm = require('./activation-dm');
  activationDm.init({ client: slackApp.client, getUserTimezone, trackError });

  // "🤝 Make this Pact" button — opens pre-filled create_pact_modal
  slackApp.action('activation_pact_create', (args) => activationDm.handleActivationPactCreate(args));
  // "Not now" — dismisses and collapses the DM
  slackApp.action('activation_dismiss', (args) => activationDm.handleActivationDismiss(args));
  // "Show me how it works" — URL button, just ack
  slackApp.action('activation_how_it_works', (args) => activationDm.handleActivationHowItWorks(args));
  // Teammate picker in activation DM — just ack (state captured when primary button is clicked)
  slackApp.action('activation_pick_teammate', async ({ ack }) => { await ack(); });

  // ── Welcome DM (immediate first-install nudge) ────────────────────────────
  welcomeDm = require('./welcome-dm');
  welcomeDm.init({ client: slackApp.client, getUserTimezone, trackError });
  slackApp.action('welcome_make_pact', (args) => welcomeDm.handleWelcomeMakePact(args));
  slackApp.action('welcome_dismiss', (args) => welcomeDm.handleWelcomeDismiss(args));
  slackApp.action('welcome_how_it_works', (args) => welcomeDm.handleWelcomeHowItWorks(args));

  // ── First-pact celebration DM ─────────────────────────────────────────────
  firstPactDm = require('./first-pact-dm');
  firstPactDm.init({ client: slackApp.client, trackError });
  slackApp.action('first_pact_make_another', (args) => firstPactDm.handleFirstPactMakeAnother(args));
  slackApp.action('first_pact_share_twitter', async ({ ack, body }) => {
    await ack();
    const userId = body.user?.id;
    const teamId = body.team?.id || body.user?.team_id;
    if (!userId || !teamId) return;
    const { recordFirstPactCelebrated } = require('./db/user-activation');
    // Log the share click — enrich the existing first_pact_celebrated record
    // by appending a share_click event alongside it
    recordFirstPactCelebrated(teamId, userId).catch(err =>
      console.error('[FIRST-PACT] Failed to log share click:', err.message)
    );
  });

  // Init streak milestones with the live Slack client now that it's available
  streakMilestones = require('./streak-milestones');
  streakMilestones.init({
    client: slackApp.client,
    getUserTimezone,
    baseUrl: require('./app-url').getAppUrl(),
  });
}


module.exports = {
  init,
  setBotUserId,
  handleCreatePact,
  handleEditPact,
  applyEditPact,
  handleSelectPactEdit,
  handleExtendPact,
  applyExtendPact,
  handleSelectPactExtend,
  handleTrackerSettings,
  handleUpgradeCommand,
  handleBillingCommand,
  handleDowngradeCommand,
  handleListPacts,
  handleDoneCommand,
  handleSelectPactComplete,
  completePact,
  startReminderChecker,
  checkReminders,
  msUntilNext9amET,
  sendDailyDigest,
  startDailyDigest,
  handleFeedbackCommand,
  detectIntent,
  getUserPacts,
  getUserNameById,
  handleDMMessage,
  handleDMGreeting,
  handleDMWhatIs,
  handleDMHelpMessage,
  buildPactsBlocks,
  handleDMListPacts,
  handleDMCreatePact,
  handleDMComplete,
  handleDMUnknown,
  handleDMConfirmPact,
  handleDMCancelPact,
  handleAcceptDmPact,
  handleDeclineDmPact,
  handleDMSelectPactComplete,
  getTriggerEmoji,
  buildReactionConfirmBlocks,
  handleReactionAdded,
  handleReactionConfirmPact,
  handleReactionSwapParties,
  handleReactionCancelPact,
  handleMessageShortcut,
  buildMessageShortcutModal,
  handleShortcutSwapParties,
  handleShortcutModalSubmit,
  buildOnboardingBlocks,
  sendWelcomeDM,
  sendNudgeDM,
  checkNudgeDue,
  sendOverdueNudge,
  checkOverduePacts,
  sendCounterpartyNudge,
  checkCounterpartyNudges,
  // Recurring pact helpers
  parseTextWithRecurrence,
  buildCreatePactModal,
  handleCreatePactModalSubmit,
  serverlessSlashCommand,
  registerSlackHandlers,
  // Streak milestone cron — called from server.js hourly scheduler
  checkStreakMilestones: () => streakMilestones ? streakMilestones.checkStreakMilestones() : Promise.resolve(),
  // Activation DM cron — called from server.js hourly scheduler
  checkActivationDue: () => require('./activation-dm').checkActivationDue(),
};
