// lib/bulk-actions.js
// Owns: bulk complete + bulk snooze flows triggered from the Home Tab.
// Does NOT own: single-pact completion, reminder DMs, or individual snooze from reminder threads.
//
// Design: Slack fires block_actions for every checkbox toggle in the Home Tab.
// Bulk action buttons (Complete, Snooze) read view.state.values to find which
// pact IDs are currently checked — no server-side selection state required.

'use strict';

const { nextDueDate, recurrenceLabel } = require('./recurrence');
const { randomUUID } = require('crypto');

// Injected via init()
let pool, formatDate, getUserTimezone, homeTab, pactDb, tracker;

function init(deps) {
  pool = deps.pool;
  formatDate = deps.formatDate;
  getUserTimezone = deps.getUserTimezone;
  homeTab = deps.homeTab;
  pactDb = deps.pactDb;
  tracker = deps.tracker;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Extract checked pact IDs from view.state.values (both owe + owed sections). */
function getCheckedPactIds(viewState) {
  const ids = new Set();
  if (!viewState) return ids;
  for (const blockValues of Object.values(viewState)) {
    for (const actionValues of Object.values(blockValues)) {
      if (actionValues.type === 'checkboxes' && Array.isArray(actionValues.selected_options)) {
        for (const opt of actionValues.selected_options) {
          const id = parseInt(opt.value, 10);
          if (!isNaN(id)) ids.add(id);
        }
      }
    }
  }
  return ids;
}

/** ISO date string N days from today (YYYY-MM-DD). */
function datePlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Complete a single pact and handle recurring next-instance creation.
 * Returns { pact, recurringNextText } or null if not authorized/found.
 */
async function completeSinglePact(pactId, userId) {
  const pact = await pactDb.markPactCompletedReturning(pactId, userId);
  if (!pact) return null;

  let recurringNextText = null;
  if (pact.recurrence_rule) {
    try {
      const rule = typeof pact.recurrence_rule === 'string'
        ? JSON.parse(pact.recurrence_rule)
        : pact.recurrence_rule;
      const baseDate = new Date(pact.due_date) < new Date() ? new Date() : new Date(pact.due_date);
      const nextDate = nextDueDate(rule, baseDate);
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
      const dateLabel = formatDate ? formatDate(nextDate, null) : nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      recurringNextText = `🔄 Next due *${dateLabel}* _(${recurrenceLabel(rule)})_`;
    } catch (recurErr) {
      console.error(`[bulk-complete] Failed to spawn recurring instance for #${pactId}:`, recurErr.message);
    }
  }

  return { pact, recurringNextText };
}

// ---------------------------------------------------------------------------
// Handler: checkbox no-op ack
// Slack fires block_actions on every checkbox toggle; we just ack — the actual
// processing happens when a bulk action button is pressed.
// ---------------------------------------------------------------------------
async function handleBulkCheckboxChange({ ack }) {
  await ack();
  // Intentional no-op: selections are read from view.state.values at action time.
}

// ---------------------------------------------------------------------------
// Handler: ✅ Complete Selected
// ---------------------------------------------------------------------------
async function handleBulkComplete({ ack, body, client }) {
  await ack();
  const userId = body.user?.id;
  const viewState = body.view?.state?.values;
  if (!userId) return;

  const pactIds = getCheckedPactIds(viewState);
  if (pactIds.size === 0) {
    // Nothing checked — show ephemeral hint (Home Tab has no respond context, use DM)
    try {
      await client.chat.postMessage({
        channel: userId,
        text: ':information_source: Select at least one pact using the checkboxes before completing.',
      });
    } catch {}
    return;
  }

  const completed = [];
  const skipped = [];

  for (const pactId of pactIds) {
    try {
      const result = await completeSinglePact(pactId, userId);
      if (result) {
        completed.push(result.pact);
        // Notify counterparty per-pact (individual, not batched here — batching done in DM below)
      } else {
        skipped.push(pactId);
      }
    } catch (err) {
      console.error(`[bulk-complete] Error completing pact #${pactId}:`, err.message);
      skipped.push(pactId);
    }
  }

  // Post completion notification
  if (completed.length > 0) {
    // Group by channel: send one per-channel summary message
    // For pacts where user is creator, notify counterparties
    const counterpartyIds = new Set();
    for (const pact of completed) {
      if (pact.creator_slack_id === userId && pact.counterparty_slack_id) {
        counterpartyIds.add(pact.counterparty_slack_id);
      } else if (pact.counterparty_slack_id === userId && pact.creator_slack_id) {
        counterpartyIds.add(pact.creator_slack_id);
      }
    }

    if (completed.length === 1) {
      const pact = completed[0];
      // Single completion — post to pact's channel (best-effort)
      const msg = `:tada: *Pact #${pact.id} completed!* _${pact.description}_\nMarked done by <@${userId}>`;
      try { await client.chat.postMessage({ channel: pact.channel_id, text: msg }); }
      catch { try { await client.chat.postMessage({ channel: userId, text: msg }); } catch {} }
    } else {
      // Batch completion — send one batched DM notification to each counterparty
      const descList = completed.map(p => `• _${p.description}_`).join('\n');
      const batchMsg = `:tada: *<@${userId}> completed ${completed.length} pacts:*\n${descList}`;

      // Post in first pact's channel (common case: all from same team DM)
      // Fall back to user DM if channel fails
      const firstChannel = completed[0].channel_id;
      try { await client.chat.postMessage({ channel: firstChannel, text: batchMsg }); }
      catch { try { await client.chat.postMessage({ channel: userId, text: batchMsg }); } catch {} }

      // DM each unique counterparty once with the batch summary
      for (const cpId of counterpartyIds) {
        if (cpId !== userId) {
          try {
            await client.chat.postMessage({ channel: cpId, text: batchMsg });
          } catch {}
        }
      }
    }
  }

  // Refresh home tab — bust cache so streak/stats update instantly
  if (homeTab) {
    homeTab.publishHomeTab(client, userId, { bustCache: true }).catch(() => {});
  }

  // Show a quick DM confirmation (ephemeral isn't available from Home Tab context)
  let summaryText = '';
  if (completed.length > 0) summaryText += `:white_check_mark: Completed ${completed.length} pact${completed.length === 1 ? '' : 's'}.`;
  if (skipped.length > 0) summaryText += ` ${skipped.length} skipped (not authorized or already done).`;
  if (summaryText) {
    try {
      await client.chat.postMessage({ channel: userId, text: summaryText });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Handler: ⏭ Snooze to Tomorrow
// ---------------------------------------------------------------------------
async function handleBulkSnoozeTomorrow({ ack, body, client }) {
  await ack();
  const userId = body.user?.id;
  const viewState = body.view?.state?.values;
  if (!userId) return;

  const pactIds = getCheckedPactIds(viewState);
  if (pactIds.size === 0) {
    try {
      await client.chat.postMessage({
        channel: userId,
        text: ':information_source: Select at least one pact using the checkboxes before snoozing.',
      });
    } catch {}
    return;
  }

  await applyBulkSnooze(userId, pactIds, datePlusDays(1), client);
}

// ---------------------------------------------------------------------------
// Handler: ⏩ Snooze +3 Days
// ---------------------------------------------------------------------------
async function handleBulkSnooze3Days({ ack, body, client }) {
  await ack();
  const userId = body.user?.id;
  const viewState = body.view?.state?.values;
  if (!userId) return;

  const pactIds = getCheckedPactIds(viewState);
  if (pactIds.size === 0) {
    try {
      await client.chat.postMessage({
        channel: userId,
        text: ':information_source: Select at least one pact using the checkboxes before snoozing.',
      });
    } catch {}
    return;
  }

  await applyBulkSnooze(userId, pactIds, datePlusDays(3), client);
}

// ---------------------------------------------------------------------------
// Handler: 📅 Snooze to Date — opens modal
// ---------------------------------------------------------------------------
async function handleBulkSnoozePickDate({ ack, body, client }) {
  await ack();
  const userId = body.user?.id;
  const viewState = body.view?.state?.values;
  const triggerId = body.trigger_id;
  if (!userId || !triggerId) return;

  const pactIds = getCheckedPactIds(viewState);
  if (pactIds.size === 0) {
    try {
      await client.chat.postMessage({
        channel: userId,
        text: ':information_source: Select at least one pact using the checkboxes before picking a date.',
      });
    } catch {}
    return;
  }

  const tomorrow = datePlusDays(1);
  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'bulk_snooze_date_modal',
        private_metadata: JSON.stringify({ pactIds: Array.from(pactIds) }),
        title: { type: 'plain_text', text: 'Snooze to Date', emoji: true },
        submit: { type: 'plain_text', text: '📅 Snooze All', emoji: true },
        close: { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Snooze ${pactIds.size} pact${pactIds.size === 1 ? '' : 's'} to a new date.*\nOnly pacts you created will be updated.`,
            },
          },
          {
            type: 'input',
            block_id: 'bulk_snooze_date_block',
            label: { type: 'plain_text', text: 'New due date' },
            element: {
              type: 'datepicker',
              action_id: 'bulk_snooze_date_input',
              initial_date: tomorrow,
              placeholder: { type: 'plain_text', text: 'Select a date' },
            },
          },
        ],
      },
    });
  } catch (err) {
    console.error('[bulk-snooze] Failed to open date picker modal:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Handler: modal submission for bulk snooze to date
// ---------------------------------------------------------------------------
async function handleBulkSnoozeDateModalSubmit({ ack, body, view, client }) {
  await ack();

  let meta;
  try { meta = JSON.parse(view.private_metadata); } catch { return; }

  const userId = body.user?.id;
  const pactIds = new Set((meta.pactIds || []).map(Number).filter(n => !isNaN(n)));
  const selectedDate = view.state?.values?.bulk_snooze_date_block?.bulk_snooze_date_input?.selected_date;

  if (!userId || !selectedDate || pactIds.size === 0) return;

  await applyBulkSnooze(userId, pactIds, selectedDate, client);
}

// ---------------------------------------------------------------------------
// Shared bulk snooze logic (creator-only, skips non-creator pacts with notice)
// ---------------------------------------------------------------------------
async function applyBulkSnooze(userId, pactIds, newDate, client) {
  const snoozed = [];
  const skipped = [];

  for (const pactId of pactIds) {
    try {
      const updated = await pactDb.snoozePactDueDate(pactId, userId, newDate);
      if (updated) {
        snoozed.push(pactId);
      } else {
        skipped.push(pactId);
      }
    } catch (err) {
      console.error(`[bulk-snooze] Error snoozing pact #${pactId}:`, err.message);
      skipped.push(pactId);
    }
  }

  // Refresh home tab
  if (homeTab) {
    homeTab.publishHomeTab(client, userId, { bustCache: false }).catch(() => {});
  }

  // Confirmation DM
  const dateFormatted = new Date(newDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  let summaryText = '';
  if (snoozed.length > 0) summaryText += `:alarm_clock: Snoozed ${snoozed.length} pact${snoozed.length === 1 ? '' : 's'} to *${dateFormatted}*.`;
  if (skipped.length > 0) summaryText += `\n:information_source: ${skipped.length} pact${skipped.length === 1 ? '' : 's'} skipped — you can only snooze your own.`;
  if (summaryText) {
    try {
      await client.chat.postMessage({ channel: userId, text: summaryText });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Handler: no-op ack for "Select all overdue" checkbox toggle re-render
// The actual "select all overdue" is done by publishing a refreshed Home Tab
// view with all overdue pacts pre-checked in the checkboxes element.
// ---------------------------------------------------------------------------
async function handleSelectAllOverdue({ ack, body, client }) {
  await ack();
  const userId = body.user?.id;
  if (!userId || !homeTab) return;
  // Re-publish with selectAllOverdue=true so all overdue pacts appear pre-checked
  homeTab.publishHomeTab(client, userId, { bustCache: true, selectAllOverdue: true }).catch(() => {});
}

module.exports = {
  init,
  handleBulkCheckboxChange,
  handleBulkComplete,
  handleBulkSnoozeTomorrow,
  handleBulkSnooze3Days,
  handleBulkSnoozePickDate,
  handleBulkSnoozeDateModalSubmit,
  handleSelectAllOverdue,
  getCheckedPactIds,
};
