// lib/workflow-builder.js
// Owns: Slack Workflow Builder step definitions — create pact, complete pact, send pact summary
// Does NOT own: pact CRUD, billing gating, reminder scheduling, DM handlers
//
// Uses Bolt's WorkflowStep API (app.step()) to register custom steps.
// Teams add Pact steps in Workflow Builder: "When X happens → Create Pact / Send Summary"
// Pro tier feature — non-Pro teams see an upgrade nudge at step-execute time.

'use strict';

// Injected via init()
let pool, parseDueDate, formatDate, getUserName, getUserTimezone, getTeamTier;

function init(deps) {
  pool = deps.pool;
  parseDueDate = deps.parseDueDate;
  formatDate = deps.formatDate;
  getUserName = deps.getUserName;
  getUserTimezone = deps.getUserTimezone;
  getTeamTier = deps.getTeamTier;
}

// ---------------------------------------------------------------------------
// Helper: log a step execution for analytics
// ---------------------------------------------------------------------------
async function logExecution(teamId, callbackId, { workflowId, userId, inputs, outputs, status, error } = {}) {
  try {
    await pool.query(
      `INSERT INTO workflow_step_executions
         (team_id, step_callback_id, workflow_id, executed_by_user_id, inputs, outputs, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        teamId,
        callbackId,
        workflowId || null,
        userId || null,
        JSON.stringify(inputs || {}),
        JSON.stringify(outputs || {}),
        status || 'completed',
        error || null,
      ]
    );
  } catch (err) {
    console.error('[workflow-builder] logExecution failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Step 1: pact_create — Create a pact from a workflow
// ---------------------------------------------------------------------------
// Inputs: promiser_user_id, counterparty_user_id, description, due_date_text
// Outputs: pact_id, pact_description, due_date_formatted
// ---------------------------------------------------------------------------
function makePactCreateStep(WorkflowStep) {
  const ws = new WorkflowStep('pact_create', {
    edit: async ({ ack, step, configure }) => {
      await ack();
      const { inputs = {} } = step;

      await configure({
        blocks: [
          {
            type: 'input',
            block_id: 'promiser_block',
            label: { type: 'plain_text', text: 'Who is making the commitment? (Promiser)' },
            element: {
              type: 'users_select',
              action_id: 'promiser_user_id',
              placeholder: { type: 'plain_text', text: 'Select a user' },
              ...(inputs.promiser_user_id?.value ? { initial_user: inputs.promiser_user_id.value } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'counterparty_block',
            label: { type: 'plain_text', text: 'Who are they committing to? (Counterparty)' },
            hint: { type: 'plain_text', text: 'Leave blank to create a solo commitment.' },
            optional: true,
            element: {
              type: 'users_select',
              action_id: 'counterparty_user_id',
              placeholder: { type: 'plain_text', text: 'Select a user (optional)' },
              ...(inputs.counterparty_user_id?.value ? { initial_user: inputs.counterparty_user_id.value } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'description_block',
            label: { type: 'plain_text', text: 'What is the commitment?' },
            element: {
              type: 'plain_text_input',
              action_id: 'description',
              placeholder: { type: 'plain_text', text: 'e.g. Send the project brief' },
              ...(inputs.description?.value ? { initial_value: inputs.description.value } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'due_date_block',
            label: { type: 'plain_text', text: 'When is it due?' },
            hint: { type: 'plain_text', text: 'Natural language: "Friday", "April 25", "next Monday at 5pm"' },
            element: {
              type: 'plain_text_input',
              action_id: 'due_date_text',
              placeholder: { type: 'plain_text', text: 'e.g. Friday, next Monday, April 25' },
              ...(inputs.due_date_text?.value ? { initial_value: inputs.due_date_text.value } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'channel_block',
            label: { type: 'plain_text', text: 'Post confirmation to channel (optional)' },
            hint: { type: 'plain_text', text: 'If set, posts a :handshake: pact confirmation here.' },
            optional: true,
            element: {
              type: 'channels_select',
              action_id: 'channel_id',
              placeholder: { type: 'plain_text', text: 'Select a channel (optional)' },
              ...(inputs.channel_id?.value ? { initial_channel: inputs.channel_id.value } : {}),
            },
          },
        ],
      });
    },

    save: async ({ ack, step, update }) => {
      await ack();
      const values = step.view.state.values;

      const inputs = {
        promiser_user_id: {
          value: values.promiser_block?.promiser_user_id?.selected_user || '',
        },
        counterparty_user_id: {
          value: values.counterparty_block?.counterparty_user_id?.selected_user || null,
        },
        description: {
          value: values.description_block?.description?.value || '',
        },
        due_date_text: {
          value: values.due_date_block?.due_date_text?.value || '',
        },
        channel_id: {
          value: values.channel_block?.channel_id?.selected_channel || null,
        },
      };

      const outputs = [
        {
          type: 'text',
          name: 'pact_id',
          label: 'Pact ID',
        },
        {
          type: 'text',
          name: 'pact_description',
          label: 'Pact description',
        },
        {
          type: 'text',
          name: 'due_date_formatted',
          label: 'Due date (formatted)',
        },
      ];

      await update({ inputs, outputs });
    },

    execute: async ({ step, complete, fail, client }) => {
      const { inputs, workflow_step } = step;
      const promiserId = inputs.promiser_user_id?.value;
      const counterpartyId = inputs.counterparty_user_id?.value || null;
      const description = inputs.description?.value || '';
      const dueDateText = inputs.due_date_text?.value || '';
      const channelId = inputs.channel_id?.value || null;

      // Extract team_id from workflow context
      const teamId = workflow_step?.workflow_id?.split('/')[0] || null;

      try {
        // Parse due date
        const { dueDate } = parseDueDate(dueDateText);
        if (!dueDate) {
          await logExecution(teamId, 'pact_create', { workflowId: workflow_step?.workflow_id, inputs: inputs, status: 'failed', error: 'Could not parse due date: ' + dueDateText });
          await fail({ error: `Could not parse due date: "${dueDateText}". Use natural language like "Friday" or "April 25".` });
          return;
        }

        if (!promiserId || !description) {
          await fail({ error: 'Promiser user and description are required.' });
          return;
        }

        // Look up names
        const [promiserName, cpName, promiserTz] = await Promise.all([
          getUserName(client, promiserId),
          counterpartyId ? getUserName(client, counterpartyId) : Promise.resolve(null),
          getUserTimezone(client, promiserId),
        ]);

        const dueDateFormatted = formatDate(dueDate, promiserTz);

        // Create pact in DB
        const result = await pool.query(
          `INSERT INTO pacts
             (team_id, channel_id, creator_slack_id, creator_name,
              counterparty_slack_id, counterparty_name, description, due_date, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
           RETURNING id`,
          [
            teamId,
            channelId || promiserId, // use promiser DM as channel if none given
            promiserId,
            promiserName,
            counterpartyId,
            cpName,
            description,
            dueDate,
          ]
        );

        const pactId = String(result.rows[0].id);

        // Optional: post confirmation to channel
        if (channelId) {
          const cpText = counterpartyId ? ` & <@${counterpartyId}>` : '';
          await client.chat.postMessage({
            channel: channelId,
            text: `:handshake: *<@${promiserId}>${cpText}* committed: *${description}* — due *${dueDateFormatted}* (Pact #${pactId})`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:handshake: *<@${promiserId}>${cpText}* committed:\n\n*${description}*\nDue: *${dueDateFormatted}*`,
                },
              },
              {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `Pact #${pactId} · Created via Workflow Builder · Type \`/done\` to complete` }],
              },
            ],
          }).catch(err => console.error('[workflow-builder] pact_create channel post failed:', err.message));
        }

        await logExecution(teamId, 'pact_create', {
          workflowId: workflow_step?.workflow_id,
          userId: promiserId,
          inputs,
          outputs: { pact_id: pactId, pact_description: description, due_date_formatted: dueDateFormatted },
          status: 'completed',
        });

        // First-pact celebration DM — lazy-require to avoid init-order issues
        if (teamId) {
          pool.query(
            `SELECT bot_token FROM installations WHERE team_id = $1 AND bot_token IS NOT NULL LIMIT 1`,
            [teamId]
          ).then(({ rows }) => {
            const botToken = rows[0]?.bot_token;
            if (!botToken) return;
            const firstPactDm = require('./first-pact-dm');
            firstPactDm.sendFirstPactCelebration({
              botToken,
              userId: promiserId,
              teamId,
              partnerName: cpName || null,
            }).catch(err => console.error('[FIRST-PACT] workflow-builder trigger error:', err.message));
          }).catch(err => console.error('[FIRST-PACT] workflow-builder bot_token lookup error:', err.message));
        }

        await complete({
          outputs: {
            pact_id: pactId,
            pact_description: description,
            due_date_formatted: dueDateFormatted,
          },
        });
      } catch (err) {
        console.error('[workflow-builder] pact_create execute error:', err.message);
        await logExecution(teamId, 'pact_create', { workflowId: workflow_step?.workflow_id, inputs, status: 'failed', error: err.message });
        await fail({ error: 'Failed to create pact: ' + err.message });
      }
    },
  });

  return ws;
}

// ---------------------------------------------------------------------------
// Step 2: pact_summary — Send a pact summary DM to a user
// ---------------------------------------------------------------------------
// Inputs: target_user_id, include_completed (true/false)
// Outputs: active_count, overdue_count, summary_text
// ---------------------------------------------------------------------------
function makePactSummaryStep(WorkflowStep) {
  const ws = new WorkflowStep('pact_summary', {
    edit: async ({ ack, step, configure }) => {
      await ack();
      const { inputs = {} } = step;

      await configure({
        blocks: [
          {
            type: 'input',
            block_id: 'user_block',
            label: { type: 'plain_text', text: 'Send pact summary to this user' },
            element: {
              type: 'users_select',
              action_id: 'target_user_id',
              placeholder: { type: 'plain_text', text: 'Select a user' },
              ...(inputs.target_user_id?.value ? { initial_user: inputs.target_user_id.value } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'include_completed_block',
            label: { type: 'plain_text', text: 'Include recently completed pacts?' },
            optional: true,
            element: {
              type: 'static_select',
              action_id: 'include_completed',
              options: [
                { text: { type: 'plain_text', text: 'Yes — show last 7 days of completions' }, value: 'yes' },
                { text: { type: 'plain_text', text: 'No — active pacts only' }, value: 'no' },
              ],
              initial_option: inputs.include_completed?.value === 'yes'
                ? { text: { type: 'plain_text', text: 'Yes — show last 7 days of completions' }, value: 'yes' }
                : { text: { type: 'plain_text', text: 'No — active pacts only' }, value: 'no' },
            },
          },
        ],
      });
    },

    save: async ({ ack, step, update }) => {
      await ack();
      const values = step.view.state.values;

      const inputs = {
        target_user_id: {
          value: values.user_block?.target_user_id?.selected_user || '',
        },
        include_completed: {
          value: values.include_completed_block?.include_completed?.selected_option?.value || 'no',
        },
      };

      const outputs = [
        { type: 'text', name: 'active_count', label: 'Active pact count' },
        { type: 'text', name: 'overdue_count', label: 'Overdue pact count' },
        { type: 'text', name: 'summary_text', label: 'Summary text' },
      ];

      await update({ inputs, outputs });
    },

    execute: async ({ step, complete, fail, client }) => {
      const { inputs, workflow_step } = step;
      const userId = inputs.target_user_id?.value;
      const includeCompleted = inputs.include_completed?.value === 'yes';
      const teamId = workflow_step?.workflow_id?.split('/')[0] || null;

      if (!userId) {
        await fail({ error: 'Target user is required.' });
        return;
      }

      try {
        const now = new Date();

        // Fetch active pacts
        const activePacts = await pool.query(
          `SELECT id, description, due_date, counterparty_slack_id, counterparty_name, creator_slack_id, creator_name
           FROM pacts
           WHERE team_id = $1
             AND (creator_slack_id = $2 OR counterparty_slack_id = $2)
             AND status = 'active'
           ORDER BY due_date ASC NULLS LAST`,
          [teamId, userId]
        );

        const overduePacts = activePacts.rows.filter(p => p.due_date && new Date(p.due_date) < now);
        const activePactsRows = activePacts.rows;

        // Optionally fetch completed pacts from last 7 days
        let completedRows = [];
        if (includeCompleted) {
          const completedResult = await pool.query(
            `SELECT id, description, due_date
             FROM pacts
             WHERE team_id = $1
               AND (creator_slack_id = $2 OR counterparty_slack_id = $2)
               AND status = 'completed'
               AND updated_at >= NOW() - INTERVAL '7 days'
             ORDER BY updated_at DESC`,
            [teamId, userId]
          );
          completedRows = completedResult.rows;
        }

        // Build DM blocks
        const activeCount = activePactsRows.length;
        const overdueCount = overduePacts.length;
        const summaryText = `Active: ${activeCount} · Overdue: ${overdueCount}${includeCompleted ? ` · Completed (7d): ${completedRows.length}` : ''}`;

        const blocks = [
          {
            type: 'header',
            text: { type: 'plain_text', text: '📋 Your Pact Summary' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Active:* ${activeCount}  ·  *Overdue:* ${overdueCount}${includeCompleted ? `  ·  *Completed (7d):* ${completedRows.length}` : ''}`,
            },
          },
        ];

        if (activePactsRows.length > 0) {
          blocks.push({ type: 'divider' });
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*Active Pacts*' },
          });

          for (const pact of activePactsRows.slice(0, 10)) {
            const isOverdue = pact.due_date && new Date(pact.due_date) < now;
            const status = isOverdue ? '🔴' : '🟢';
            const dueStr = pact.due_date ? formatDate(pact.due_date) : 'No due date';
            const other = pact.creator_slack_id === userId
              ? (pact.counterparty_name || 'Unknown')
              : (pact.creator_name || 'Unknown');
            blocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${status} *${pact.description}*\nDue: ${dueStr} · With: ${other}`,
              },
            });
          }
        }

        if (includeCompleted && completedRows.length > 0) {
          blocks.push({ type: 'divider' });
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*Completed in last 7 days*' },
          });
          for (const pact of completedRows.slice(0, 5)) {
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `✅ ${pact.description}` },
            });
          }
        }

        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Sent via Pact Workflow Builder · Use `/pact help` to learn more' }],
        });

        // Send DM to target user
        await client.chat.postMessage({
          channel: userId,
          text: summaryText,
          blocks,
        });

        await logExecution(teamId, 'pact_summary', {
          workflowId: workflow_step?.workflow_id,
          userId,
          inputs,
          outputs: { active_count: String(activeCount), overdue_count: String(overdueCount), summary_text: summaryText },
          status: 'completed',
        });

        await complete({
          outputs: {
            active_count: String(activeCount),
            overdue_count: String(overdueCount),
            summary_text: summaryText,
          },
        });
      } catch (err) {
        console.error('[workflow-builder] pact_summary execute error:', err.message);
        await logExecution(teamId, 'pact_summary', { workflowId: workflow_step?.workflow_id, inputs, status: 'failed', error: err.message });
        await fail({ error: 'Failed to send pact summary: ' + err.message });
      }
    },
  });

  return ws;
}

// ---------------------------------------------------------------------------
// Register all Workflow Builder steps with the Bolt App
// ---------------------------------------------------------------------------
function registerWorkflowSteps(slackApp) {
  let WorkflowStep;
  try {
    ({ WorkflowStep } = require('@slack/bolt'));
  } catch (err) {
    console.error('[workflow-builder] @slack/bolt not available — WorkflowStep not registered:', err.message);
    return;
  }

  slackApp.step(makePactCreateStep(WorkflowStep));
  slackApp.step(makePactSummaryStep(WorkflowStep));

  console.log('[workflow-builder] Registered WorkflowSteps: pact_create, pact_summary');
}

module.exports = { init, registerWorkflowSteps };
